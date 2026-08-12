// Trip.com saglayicisi.
//
// Bot duvari yok, TL fiyatlari dogrudan DOM'a basiyor ve bu rotalarda
// diger kaynaklardan belirgin ucuz cikabiliyor (AirAsia/DMK tarifeleri).
//
// API'yi tersine muhendislikle cozmek yerine liste satirlarini okuyoruz;
// satirlar tek bir kapsayicida (.f-info-content) ve duzenli bir sirada:
//   "Havayolu | 17:20 | SAW | 20 sa 50 dk | <aktarma bilgisi> | 18:10 | DMK | +1 | 11.902 TL | Sec"

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const CONSENT = ['Tümünü kabul et', 'Kabul Et', 'Kabul et', 'Accept all', 'Onayla'];

function buildUrl(from, to, date) {
  const q = new URLSearchParams({
    dcity: from.toLowerCase(), acity: to.toLowerCase(), ddate: date,
    triptype: 'ow', class: 'y', quantity: '1', locale: 'tr-TR', curr: 'TRY',
  });
  return `https://tr.trip.com/flights/showfarefirst?${q}`;
}

function parseRow(text, search) {
  const t = text.replace(/\s*\|\s*/g, ' | ').trim();

  const price = t.match(/([\d.]{4,})\s?TL/);
  if (!price) return null;
  const priceTRY = parseInt(price[1].replace(/\./g, ''), 10);
  if (!Number.isFinite(priceTRY) || priceTRY <= 0) return null;

  // Iki saat damgasi: ilki kalkis, ikincisi varis
  const times = [...t.matchAll(/(?<![\d:])(\d{1,2}:\d{2})(?![\d:])/g)].map(m => m[1]);
  if (times.length < 2) return null;
  const depTime = times[0].padStart(5, '0');
  const arrTime = times[1].padStart(5, '0');

  const plus = t.match(/\+\s?(\d)/);
  const plusDays = plus ? parseInt(plus[1], 10) : 0;

  const d = t.match(/(\d+)\s*sa\s*(?:(\d+)\s*dk)?/);
  const durationMin = d ? parseInt(d[1], 10) * 60 + (d[2] ? parseInt(d[2], 10) : 0) : null;

  const stops = /Aktarmasız/i.test(t) ? 0 : (t.match(/aktarma süresi/gi) || []).length || null;

  // Havalimani kodlari: saat damgalarindan sonra gelen 3 harfli kodlar
  const codes = [...t.matchAll(/\b([A-Z]{3})\b/g)].map(m => m[1]).filter(c => c !== 'TL');
  const airline = t.split('|')[0].trim().slice(0, 60);

  return {
    priceTRY, depTime, arrTime, plusDays, durationMin, stops,
    origin: codes[0] || null,
    dest: codes.length > 1 ? codes[codes.length - 1] : null,
    airline: airline || 'Bilinmiyor',
    provider: 'Trip.com',
    vendor: 'Trip.com',
    search: search.label,
    date: search.date,
  };
}

async function scrapeOnce(browser, from, to, date, search) {
  const ctx = await browser.newContext({
    locale: 'tr-TR', timezoneId: 'Europe/Istanbul', userAgent: UA,
    viewport: { width: 1440, height: 1200 },
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await ctx.newPage();

  try {
    await page.goto(buildUrl(from, to, date), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);

    for (const label of CONSENT) {
      const btn = page.getByRole('button', { name: label, exact: false });
      if (await btn.count().catch(() => 0)) {
        await btn.first().click({ timeout: 5000 }).catch(() => {});
        break;
      }
    }

    await page.waitForSelector('.f-info-content', { timeout: 45000 });
    // Liste kademeli yukleniyor; kaydirarak tamamini getir
    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => window.scrollBy(0, 2500));
      await page.waitForTimeout(2200);
    }

    const rows = await page.$$eval('.f-info-content', els =>
      els.map(e => (e.innerText || '').replace(/\n+/g, ' | ')));

    const out = [];
    for (const r of rows) {
      const f = parseRow(r, search);
      if (f) out.push(f);
    }
    return { flights: out, error: null };
  } catch (e) {
    return { flights: [], error: e.message.split('\n')[0] };
  } finally {
    await ctx.close().catch(() => {});
  }
}

/**
 * Tek arama. Trip.com IATA kodlarini SEHIR olarak yorumluyor: "ist" hem IST
 * hem SAW'i, "bkk" hem BKK hem DMK'yi kapsiyor. O yuzden kombinasyonlari tek
 * tek sormaya gerek yok — tek sorgu hepsini getiriyor, tur suresi de dortte
 * birine iniyor.
 */
async function searchTripcom(browser, search, attempts = 2) {
  const from = (search.fromCodes || [])[0];
  const to = (search.toCodes || (search.to ? [search.to] : []))[0];
  if (!from || !to) return { flights: [], error: 'fromCodes/toCodes tanimli degil' };

  for (let i = 1; i <= attempts; i++) {
    const { flights, error } = await scrapeOnce(browser, from, to, search.date, search);
    if (!error) return { flights, error: null };
    if (i === attempts) return { flights: [], error: `${from}->${to}: ${error}` };
    await new Promise(r => setTimeout(r, i * 5000));
  }
}

module.exports = { searchTripcom, parseRow, buildUrl };
