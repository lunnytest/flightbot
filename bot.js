#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { launchBrowser, scrapeSearch } = require('./scrape');
const SL = require('./skiplagged');

const ROOT = __dirname;
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const STATE_FILE = path.join(ROOT, 'state.json');
const LOG_DIR = path.join(ROOT, 'logs');

const WEBHOOK = process.env.DISCORD_WEBHOOK || CONFIG.discordWebhook || '';

// Test/deneme için config'i elle değiştirmeden geçici override:
//   ALERT_THRESHOLD=16000 LOG_THRESHOLD=17000 INTERVAL_MIN=5 node bot.js --once
if (process.env.ALERT_THRESHOLD) CONFIG.alertThresholdTRY = Number(process.env.ALERT_THRESHOLD);
if (process.env.LOG_THRESHOLD) CONFIG.logThresholdTRY = Number(process.env.LOG_THRESHOLD);
if (process.env.INTERVAL_MIN) CONFIG.intervalMinutes = Number(process.env.INTERVAL_MIN);
const RE_ALERT_AFTER_MS = 6 * 60 * 60 * 1000; // re-announce a still-cheap flight at most every 6h

fs.mkdirSync(LOG_DIR, { recursive: true });

// ---------- helpers ----------

const tsISO = () => new Date().toISOString();
const tsLocal = () => new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });

function log(line) {
  const msg = `[${tsLocal()}] ${line}`;
  console.log(msg);
  const day = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(path.join(LOG_DIR, `${day}.log`), msg + '\n');
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

const money = n => '₺' + n.toLocaleString('tr-TR');

function dur(min) {
  if (min == null) return '?';
  return `${Math.floor(min / 60)}s ${String(min % 60).padStart(2, '0')}d`;
}

function stopsLabel(s) {
  if (s === 0) return 'Aktarmasız';
  if (s == null) return '? aktarma';
  return `${s} aktarma`;
}

const toMinutes = hhmm => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

// Fiyat anahtarın parçası DEĞİL: aynı uçuş ucuzlarsa "cheaper" kontrolü tekrar haber versin.
function flightKey(f) {
  return [f.search, f.date, f.airline, f.depTime, f.arrTime, f.stops].join('|');
}

/**
 * Aynı uçuş hem Google'dan hem Skiplagged'den gelebiliyor. Özet listesinde
 * aynı seferi iki kez göstermemek için tekilleştirip en ucuzunu tutuyoruz.
 */
function dedupeAcrossProviders(flights) {
  const byKey = new Map();
  for (const f of flights) {
    const key = [f.search, f.date, f.depTime, f.arrTime, f.stops].join('|');
    const prev = byKey.get(key);
    if (!prev || f.priceTRY < prev.priceTRY) byKey.set(key, f);
  }
  return [...byKey.values()].sort((a, b) => a.priceTRY - b.priceTRY);
}

/**
 * Aynı tarife onlarca aktarma varyantıyla geliyor (aynı gün, aynı havayolu,
 * aynı fiyat, sadece bekleme süresi farklı). Özette 5 slotun 5'ini tek bir
 * tarifeye harcamamak için bunları teke indirip en kısa süreliyi tutuyoruz.
 */
function distinctOffers(sorted) {
  const seen = new Map();
  for (const f of sorted) {
    const key = [f.search, f.date, f.airline, f.priceTRY].join('|');
    const prev = seen.get(key);
    if (!prev || (f.durationMin || 1e9) < (prev.durationMin || 1e9)) seen.set(key, f);
  }
  return [...seen.values()].sort((a, b) => a.priceTRY - b.priceTRY);
}

function fmtFlight(f) {
  const plus = f.plusDays ? `+${f.plusDays}` : '';
  const t = f.depTime ? `${f.depTime}→${f.arrTime}${plus}` : '(saat okunamadı)';
  const ap = f.origin ? ` [${f.origin}]` : '';
  const src = f.vendor && f.vendor !== f.provider ? `${f.provider}→${f.vendor}` : (f.provider || '?');
  return `${money(f.priceTRY)} — ${f.search}${ap} ${f.date} | ${t} | ` +
    `${f.airline} | ${dur(f.durationMin)} | ${stopsLabel(f.stops)} | ${src}` +
    (f.depTime ? '' : ` | ham: ${f.raw}`);
}

function googleLink(f, search) {
  const q = `Flights to ${search.to} from ${search.from} on ${search.date} oneway`;
  return 'https://www.google.com/travel/flights?q=' + encodeURIComponent(q) +
    `&curr=${CONFIG.currency}&hl=tr&gl=TR`;
}

// ---------- discord ----------

async function sendDiscord(deals, searchByLabelDate) {
  // --dry-run: her seyi calistir ama bildirim gonderme (ayar dogrulamak icin)
  if (process.argv.includes('--dry-run')) {
    log(`>> [dry-run] ${deals.length} bilet icin bildirim GONDERILMEDI.`);
    return;
  }
  if (!WEBHOOK) {
    log('!! Discord webhook ayarlanmamış — bildirim atlanıyor (config.json > discordWebhook).');
    return;
  }

  const fields = deals.slice(0, 10).map(f => {
    const plus = f.plusDays ? `+${f.plusDays}` : '';
    const link = googleLink(f, searchByLabelDate[`${f.search}|${f.date}`]);
    const when = f.depTime ? `${f.depTime} → ${f.arrTime}${plus}` : '(saat okunamadı)';
    return {
      name: `${money(f.priceTRY)} · ${f.search}${f.origin ? ` [${f.origin}]` : ''} · ${f.date}`,
      value: `${when} · ${f.airline}\n` +
             `${dur(f.durationMin)} · ${stopsLabel(f.stops)} · **${f.vendor || f.provider}**\n` +
             `[Google Flights](${link}) · [Skiplagged](https://skiplagged.com/flights/${f.origin || 'IST'}/${f.dest || ''}/${f.date})`,
    };
  });

  const cheapest = deals[0];
  const body = {
    content: (CONFIG.mentionEveryone ? '@everyone ' : '') +
      `✈️ **${money(cheapest.priceTRY)}** — eşiğin (${money(CONFIG.alertThresholdTRY)}) altında ${deals.length} bilet var!`,
    allowed_mentions: { parse: CONFIG.mentionEveryone ? ['everyone'] : [] },
    embeds: [{
      title: '🔥 Ucuz bilet alarmı',
      color: 0x2ecc71,
      fields,
      footer: { text: `Kontrol: ${tsLocal()} · her ${CONFIG.intervalMinutes} dk` },
      timestamp: tsISO(),
    }],
  };

  try {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) log(`!! Discord webhook hatası: HTTP ${res.status} ${await res.text()}`);
    else log(`>> Discord'a ${deals.length} bilet gönderildi.`);
  } catch (e) {
    log(`!! Discord gönderilemedi: ${e.message}`);
  }
}

/** Her turda gonderilen duzenli ozet: en ucuz N bilet + rota basina durum. */
async function sendDigest(top, allUniq, searchByLabelDate) {
  const cfg = CONFIG.digest || {};
  if (process.argv.includes('--dry-run')) {
    log(`>> [dry-run] özet GÖNDERİLMEDİ (${top.length} bilet).`);
    top.forEach((f, i) => log(`   ${i + 1}. ${fmtFlight(f)}`));
    return;
  }
  if (!WEBHOOK) { log('!! Webhook yok, özet atlanıyor.'); return; }

  const fields = top.map((f, i) => {
    const plus = f.plusDays ? `+${f.plusDays}` : '';
    const link = googleLink(f, searchByLabelDate[`${f.search}|${f.date}`]);
    return {
      name: `${i + 1}. ${money(f.priceTRY)} · ${f.search}${f.origin ? ` [${f.origin}]` : ''} · ${f.date}`,
      value: `${f.depTime} → ${f.arrTime}${plus} · ${f.airline}\n` +
             `${dur(f.durationMin)} · ${stopsLabel(f.stops)} · **${f.vendor || f.provider}**\n` +
             `[Google Flights](${link}) · [Skiplagged](https://skiplagged.com/flights/${f.origin || ''}/${f.dest || ''}/${f.date})`,
    };
  });

  // En ucuz 5 tek bir rotada yogunlasabiliyor; hicbir rota gozden kacmasin diye
  // her arama icin tek satirlik ozet de ekliyoruz.
  const perSearch = [];
  for (const key of Object.keys(searchByLabelDate)) {
    const s = searchByLabelDate[key];
    const rows = allUniq.filter(f => f.search === s.label && f.date === s.date);
    if (rows.length) perSearch.push(`\`${s.label.replace('IST -> ', '')} ${s.date}\` **${money(rows[0].priceTRY)}**`);
  }
  if (perSearch.length) {
    fields.push({ name: '​', value: 'Tüm rotaların en ucuzu:\n' + perSearch.join('\n') });
  }

  const body = {
    content: (cfg.mentionEveryone ? '@everyone ' : '') +
      `✈️ En ucuz ${top.length} bilet — şu anki en düşük **${money(top[0].priceTRY)}**`,
    allowed_mentions: { parse: cfg.mentionEveryone ? ['everyone'] : [] },
    embeds: [{
      title: '📋 Düzenli fiyat özeti',
      color: 0x3498db,
      fields,
      footer: { text: `${tsLocal()} · her ${CONFIG.intervalMinutes} dk · Google + Skiplagged/Skyscanner` },
      timestamp: tsISO(),
    }],
  };

  try {
    const res = await fetch(WEBHOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) log(`!! Özet gönderilemedi: HTTP ${res.status} ${await res.text()}`);
    else log(`>> Discord'a özet gönderildi (en ucuz ${top.length} bilet).`);
  } catch (e) {
    log(`!! Özet gönderilemedi: ${e.message}`);
  }
}

// ---------- one cycle ----------

async function runCycle() {
  const state = loadState();
  const browser = await launchBrowser(CONFIG.headless);
  const all = [];
  const searchByLabelDate = {};

  // Skiplagged oturumu: Cloudflare bir kez asilir, sonra butun aramalar
  // ayni sayfanin icinden fetch ile yapilir.
  let skip = null;
  try {
    skip = await SL.openSession(browser, CONFIG.searches[0]);
    log(`Skiplagged oturumu açıldı (USD→TL kuru ${skip.rate}, kaynak: ${skip.rateSource}).`);
  } catch (e) {
    log(`!! Skiplagged oturumu açılamadı: ${e.message} — sadece Google Flights kullanılacak.`);
  }

  try {
    for (const search of CONFIG.searches) {
      searchByLabelDate[`${search.label}|${search.date}`] = search;

      const { flights, error, recoveredAfter } = await scrapeSearch(browser, search, CONFIG.currency);
      if (error) {
        log(`!! ${search.label} ${search.date} — Google hatası: ${error}`);
      }
      if (recoveredAfter) log(`   (${recoveredAfter}. denemede toparlandı)`);
      flights.forEach(f => { f.provider = 'Google'; });

      if (skip) {
        try {
          flights.push(...await SL.searchSkiplagged(skip, search));
        } catch (e) {
          log(`!! ${search.label} ${search.date} — Skiplagged hatası: ${e.message}`);
        }
      }

      // Saat kısıtı olan aramalarda (5 Eylül) kalkış saatine göre ele.
      // Saati okunamayan satırı ELEMİYORUZ — ucuz bileti kaçırmaktansa işaretleyip gösteriyoruz.
      let kept = flights;
      let unparsed = 0;
      if (search.minDepartureTime) {
        const min = toMinutes(search.minDepartureTime);
        kept = flights.filter(f => {
          if (!f.depTime) { unparsed++; f.timeUnknown = true; return true; }
          return toMinutes(f.depTime) >= min;
        });
      }
      if (unparsed) log(`   (uyarı: ${unparsed} satırın kalkış saati okunamadı, yine de dahil edildi)`);

      const cheapest = kept.length ? kept.reduce((a, b) => (a.priceTRY < b.priceTRY ? a : b)) : null;
      const per = p => {
        const s = kept.filter(f => f.provider === p);
        return s.length ? `${p} ${s.length}/${money(Math.min(...s.map(f => f.priceTRY)))}` : `${p} —`;
      };
      log(`${search.label} ${search.date}${search.minDepartureTime ? ` (${search.minDepartureTime} sonrası)` : ''}` +
          ` — ${per('Google')}, ${per('Skiplagged')}` +
          (cheapest ? ` | en ucuz ${money(cheapest.priceTRY)} (${cheapest.vendor || cheapest.provider})` : ''));

      all.push(...kept);

      // Google'ı yormamak için aramalar arasında rastgele bekleme
      await new Promise(r => setTimeout(r, 3000 + Math.random() * 4000));
    }
  } finally {
    if (skip) await SL.closeSession(skip).catch(() => {});
    await browser.close().catch(() => {});
  }

  if (!all.length) {
    log('Bu turda hiç sonuç alınamadı.');
    return;
  }

  // --- her turda gönderilen düzenli özet ---
  const uniq = dedupeAcrossProviders(all);
  const digest = CONFIG.digest || {};
  if (digest.enabled) {
    const top = distinctOffers(uniq).slice(0, digest.count || 5);
    if (top.length) {
      log(`--- en ucuz ${top.length} bilet ---`);
      top.forEach((f, i) => log(`   ${i + 1}. ${fmtFlight(f)}`));
      await sendDigest(top, uniq, searchByLabelDate);
    }
  }

  // --- eşik altındakileri logla ---
  const logged = all
    .filter(f => f.priceTRY < CONFIG.logThresholdTRY)
    .sort((a, b) => a.priceTRY - b.priceTRY);

  if (logged.length) {
    log(`--- ${money(CONFIG.logThresholdTRY)} altı ${logged.length} bilet ---`);
    for (const f of logged) log('   ' + fmtFlight(f));
  } else {
    const min = all.reduce((a, b) => (a.priceTRY < b.priceTRY ? a : b));
    log(`${money(CONFIG.logThresholdTRY)} altı bilet yok. Genel en ucuz: ${fmtFlight(min)}`);
  }

  // --- gerçek alarm: eşik altı + daha önce duyurulmamış / daha da ucuzlamış ---
  const now = Date.now();
  const candidates = all
    .filter(f => f.priceTRY < CONFIG.alertThresholdTRY)
    .sort((a, b) => a.priceTRY - b.priceTRY);

  const fresh = [];
  for (const f of candidates) {
    const k = flightKey(f);
    const prev = state[k];
    const isNew = !prev;
    const cheaper = prev && f.priceTRY < prev.price;
    const stale = prev && now - prev.at > RE_ALERT_AFTER_MS;
    if (isNew || cheaper || stale) {
      fresh.push(f);
      state[k] = { price: f.priceTRY, at: now };
    }
  }

  // eski kayıtları temizle (7 günden eski)
  for (const [k, v] of Object.entries(state)) {
    if (now - v.at > 7 * 24 * 60 * 60 * 1000) delete state[k];
  }
  saveState(state);

  if (fresh.length) {
    log(`!!! ALARM: ${money(CONFIG.alertThresholdTRY)} altı ${fresh.length} yeni bilet.`);
    await sendDiscord(fresh, searchByLabelDate);
  }
}

// ---------- loop ----------

async function main() {
  const once = process.argv.includes('--once');
  log(`Bot başladı. Alarm eşiği ${money(CONFIG.alertThresholdTRY)}, log eşiği ${money(CONFIG.logThresholdTRY)}, ` +
      `periyot ${CONFIG.intervalMinutes} dk, ${CONFIG.searches.length} arama.` +
      (WEBHOOK ? '' : ' (webhook YOK)'));

  while (true) {
    const t0 = Date.now();
    try {
      await runCycle();
    } catch (e) {
      log(`!! Tur çöktü: ${e.message}`);
    }
    log(`Tur bitti (${Math.round((Date.now() - t0) / 1000)} sn).`);

    if (once) break;
    log(`${CONFIG.intervalMinutes} dk bekleniyor...\n`);
    await new Promise(r => setTimeout(r, CONFIG.intervalMinutes * 60 * 1000));
  }
}

main();
