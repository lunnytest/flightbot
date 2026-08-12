// Skiplagged saglayicisi.
//
// Skiplagged Cloudflare arkasinda: duz istek 403 doner. Ama gercek tarayici
// challenge'i cozuyor; sonrasinda sayfanin ICINDEN fetch atinca ayni oturumun
// cerezleri kullaniliyor ve API dogrudan JSON donuyor. Boylece tek sayfa
// yuklemesiyle butun aramalar yapilabiliyor.
//
// API fiyatlari USD cent cinsinden; TL kuru currency.php'den geliyor.
// Her itinerary icin OTA fiyatlari ayri ayri var (FlightNetwork, Gotogate,
// Mytrip, Kiwi, FAST ve SKYSCANNER) — en ucuzunu aliyoruz.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Bagimsiz USD->TRY kuru. Skiplagged TRY vermediginde kullanilir. */
async function usdToTry(attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 15000);
      const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: ctl.signal });
      clearTimeout(t);
      const j = await res.json();
      const r = j && j.rates && j.rates.TRY;
      // Sacma bir deger gelirse kullanma (API bozulursa fiyatlar sapitmasin)
      if (typeof r === 'number' && r > 5 && r < 1000) return r;
    } catch {}
    if (i < attempts) await new Promise(r => setTimeout(r, i * 3000));
  }
  return null;
}

/**
 * Tarayicida bir Skiplagged oturumu acar: Cloudflare'i asar, TL kurunu alir.
 * Acilis sayfasi ilk aramadan turetilir, sabit rota yok.
 */
async function openSession(browser, seed) {
  const seedUrl = 'https://skiplagged.com/flights/' +
    `${(seed.fromCodes || [])[0]}/${seed.to}/${seed.date}`;
  const ctx = await browser.newContext({
    locale: 'tr-TR', timezoneId: 'Europe/Istanbul', userAgent: UA,
    viewport: { width: 1440, height: 900 },
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await ctx.newPage();

  let rate = null;
  page.on('response', async r => {
    if (!r.url().includes('/api/currency.php')) return;
    try {
      const j = JSON.parse(await r.text());
      if (j.currency === 'TRY' && j.rate) rate = j.rate;
    } catch {}
  });

  await page.goto(seedUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(12000); // challenge + ilk arama

  let rateSource = 'skiplagged';

  if (!rate) {
    // currency.php yakalanamadiysa dogrudan sor
    rate = await page.evaluate(async () => {
      try {
        const r = await fetch('https://skiplagged.com/api/currency.php', { credentials: 'include' });
        const j = await r.json();
        return j.currency === 'TRY' ? j.rate : null;
      } catch { return null; }
    });
  }

  // Skiplagged para birimini SUNUCUNUN IP'sine gore seciyor ve degistirilemiyor
  // (cerez de secici de ise yaramadi). ABD'deki bir runner'da TRY yerine USD
  // secilir. Ama API fiyatlari her zaman USD cent, o yuzden bize sadece
  // USD->TRY kuru lazim; bulamazsak disaridan aliyoruz.
  if (!rate) {
    rate = await usdToTry();
    rateSource = 'open.er-api.com';
  }
  if (!rate) throw new Error('USD->TRY kuru hicbir kaynaktan alinamadi');

  return { ctx, page, rate, rateSource };
}

async function closeSession(s) {
  await s.ctx.close().catch(() => {});
}

/**
 * Skiplagged arama sonuclari kademeli doluyor; sayi artmayi birakana kadar
 * tekrar sorup en dolu yaniti aliyoruz.
 */
async function fetchItineraries(page, { from, to, date }, rounds = 4) {
  let best = null;
  for (let i = 0; i < rounds; i++) {
    const j = await page.evaluate(async ({ from, to, date }) => {
      const q = new URLSearchParams({
        from, to, depart: date, return: '', format: 'v3', sort: 'cost',
        'counts[adults]': '1', 'counts[children]': '0',
        'counts[infants_lap]': '0', 'counts[infants_seat]': '0',
      });
      const res = await fetch(`https://skiplagged.com/api/search.php?${q}`, { credentials: 'include' });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      return await res.json();
    }, { from, to, date });

    if (j.error) throw new Error(j.error);
    const n = ((j.itineraries || {}).outbound || []).length;
    if (!best || n > best.n) best = { j, n };
    // Sonuc sayisi artmadiysa dolmus demektir
    if (best.n === n && i > 0) break;
    await page.waitForTimeout(3000);
  }
  return best ? best.j : null;
}

const hhmm = iso => iso.slice(11, 16);
const dayOf = iso => iso.slice(0, 10);

function normalize(j, rate, search) {
  const out = [];
  const airlines = j.airlines || {};
  for (const it of (j.itineraries || {}).outbound || []) {
    const flight = (j.flights || {})[it.flight];
    if (!flight || !flight.segments || !flight.segments.length) continue;

    // Her OTA'nin fiyati ayri; gercekten alinabilecek en ucuzu istiyoruz.
    let cents = it.one_way_price, vendor = 'Skiplagged';
    try {
      const src = JSON.parse(it.data.split('|')[1]).source[0].source;
      for (const [name, val] of Object.entries(src)) {
        if (val[1] && val[1] < cents) { cents = val[1]; vendor = name; }
      }
    } catch {}

    const segs = flight.segments;
    const dep = segs[0].departure, arr = segs[segs.length - 1].arrival;
    const codes = [...new Set(segs.map(s => s.airline))];

    out.push({
      priceTRY: Math.round(cents * rate / 100),
      depTime: hhmm(dep.time),
      arrTime: hhmm(arr.time),
      plusDays: Math.round(
        (Date.parse(dayOf(arr.time)) - Date.parse(dayOf(dep.time))) / 86400000),
      durationMin: Math.round(flight.duration / 60),
      stops: segs.length - 1,
      origin: dep.airport,
      dest: arr.airport,
      airline: codes.map(c => (airlines[c] || {}).name || c).join(', ').slice(0, 60),
      provider: 'Skiplagged',
      vendor,                       // fiyatin geldigi OTA (Skyscanner olabilir)
      search: search.label,
      date: search.date,
    });
  }
  return out;
}

/** Tek arama. Birden fazla kalkis havalimani tanimliysa hepsi sorulur. */
async function searchSkiplagged(session, search) {
  const codes = search.fromCodes || [];
  if (!codes.length) throw new Error('fromCodes tanimli degil');
  const all = [];
  for (const from of codes) {
    const j = await fetchItineraries(session.page, { from, to: search.to, date: search.date });
    if (j) all.push(...normalize(j, session.rate, search));
    await session.page.waitForTimeout(1500);
  }
  return all;
}

module.exports = { openSession, closeSession, searchSkiplagged };
