// scripts/scrape.mjs
//
// يقرأ سعري الدولار واليورو مقابل الجنيه المصري من مصدرين:
//  1) نشرة بنك مصر الرسمية (banquemisr.com) - جدول HTML ثابت.
//  2) صفحة البنك العربي الدولي على مجمّع ta3weem.com (لأن موقع AIB الرسمي
//     aib.com.eg يعرض جدول الأسعار عبر جافاسكربت ديناميكي لا يظهر في HTML
//     الخام، فلا يمكن قراءته بجلب بسيط من طرف الخادم).
//
// تنبيه مهم: لم يتم فحص الشيفرة المصدرية الفعلية لهاتين الصفحتين مباشرة عند
// كتابة هذا السكربت (الأداة التي كُتب بها هذا الملف تصفّح الويب عبر ملخّص لا
// عبر HTML خام)، لذلك التحليل هنا يعتمد على نمط عام (البحث عن اسم العملة ثم
// أقرب رقمين عشريين بعده) بدل محددات CSS دقيقة. من المرجّح أن تحتاج لضبط
// دالة extractRate أو الروابط أدناه بعد أول تشغيل فعلي - راجع القسم
// "التحقق والصيانة" في README.md.
//
// كذلك: تحقق من شروط استخدام كل موقع قبل تفعيل الجلب الدوري بشكل دائم على
// نطاق واسع، وأبقِ وتيرة الجلب معقولة (مرة كل ساعة أو ساعتين تكفي تماماً
// لهذا الغرض).

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const OUT_PATH = new URL('../data/rates.json', import.meta.url);

const SOURCES = {
  banquemisr: {
    url: 'https://www.banquemisr.com/Home/CAPITAL%20MARKETS/Exchange%20rates%20and%20currencies?sc_lang=ar-EG',
    labels: {
      USD: ['الدولار الأمريكى', 'الدولار الأمريكي', 'دولار أمريكي', 'USD'],
      EUR: ['اليورو الأوروبى', 'اليورو الأوروبي', 'يورو أوروبي', 'يورو', 'EUR']
    }
  },
  aib: {
    // مصدر بديل (مجمّع) وليس موقع AIB الرسمي - راجع الملاحظة أعلى الملف.
    url: 'https://ta3weem.com/en/banks/arab-international-bank-aib',
    labels: {
      USD: ['US Dollar', 'USD', 'دولار'],
      EUR: ['Euro', 'EUR', 'يورو']
    }
  }
};

// نطاقات معقولة للتحقق من صحة الأرقام المُستخرجة (تحدّث هذه الحدود إذا تحرك
// الجنيه المصري بشكل كبير مستقبلاً حتى لا تُرفض قيم صحيحة بالخطأ).
const SANITY = {
  USD: { min: 30, max: 90 },
  EUR: { min: 35, max: 100 }
};

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ');
}

// يبحث عن أول تسمية عملة مطابقة، ثم يلتقط أول رقمين عشريين (وليسا نسبة
// مئوية) ضمن نافذة نص قصيرة بعدها، ويعتبرهما (شراء، بيع).
function extractRate(text, labels, range) {
  for (const label of labels) {
    let searchFrom = 0;
    while (true) {
      const idx = text.indexOf(label, searchFrom);
      if (idx === -1) break;
      const windowText = text.slice(idx, idx + 260);
      const matches = [...windowText.matchAll(/(\d{1,3}\.\d{2,6})(?!\s*%)/g)].map(m => parseFloat(m[1]));
      const valid = matches.filter(v => v >= range.min && v <= range.max);
      if (valid.length >= 2) {
        const buy = Math.min(valid[0], valid[1]);
        const sell = Math.max(valid[0], valid[1]);
        if (sell > buy && (sell - buy) / buy < 0.05) {
          return { buy: +buy.toFixed(4), sell: +sell.toFixed(4) };
        }
      }
      searchFrom = idx + label.length;
    }
  }
  return null;
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'accept-language': 'ar,en;q=0.8'
      }
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return await resp.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function scrapeSource(key, cfg) {
  const result = { source: cfg.url, fetchedAt: new Date().toISOString(), ok: false, USD: null, EUR: null, error: null };
  try {
    const html = await fetchText(cfg.url);
    const text = stripHtml(html);
    result.USD = extractRate(text, cfg.labels.USD, SANITY.USD);
    result.EUR = extractRate(text, cfg.labels.EUR, SANITY.EUR);
    result.ok = !!(result.USD && result.EUR);
    if (!result.ok) result.error = 'تعذّر العثور على رقمين صالحين قرب اسم العملة (قد يكون هيكل الصفحة تغيّر)';
  } catch (e) {
    result.error = String(e && e.message ? e.message : e);
  }
  return result;
}

async function loadPrevious() {
  try {
    if (!existsSync(OUT_PATH)) return null;
    const raw = await readFile(OUT_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function main() {
  const prev = await loadPrevious();
  const bm = await scrapeSource('banquemisr', SOURCES.banquemisr);
  const aib = await scrapeSource('aib', SOURCES.aib);

  const errors = [];
  if (!bm.ok) errors.push('banquemisr: ' + bm.error);
  if (!aib.ok) errors.push('aib: ' + aib.error);

  const out = {
    generatedAt: new Date().toISOString(),
    ok: bm.ok && aib.ok,
    errors,
    USD: {
      banquemisr: bm.ok ? { ...bm.USD, source: bm.source, fetchedAt: bm.fetchedAt } : (prev?.USD?.banquemisr ?? null),
      aib: aib.ok ? { ...aib.USD, source: aib.source, fetchedAt: aib.fetchedAt } : (prev?.USD?.aib ?? null)
    },
    EUR: {
      banquemisr: bm.ok ? { ...bm.EUR, source: bm.source, fetchedAt: bm.fetchedAt } : (prev?.EUR?.banquemisr ?? null),
      aib: aib.ok ? { ...aib.EUR, source: aib.source, fetchedAt: aib.fetchedAt } : (prev?.EUR?.aib ?? null)
    }
  };

  // إن فشل المصدران معاً ولا توجد بيانات سابقة أصلاً، اخرج بخطأ واضح بدل كتابة ملف فارغ.
  const hasAnyData = out.USD.banquemisr || out.USD.aib || out.EUR.banquemisr || out.EUR.aib;
  if (!hasAnyData) {
    console.error('فشل الجلب من المصدرين ولا توجد بيانات سابقة لحفظها:', errors.join(' | '));
    process.exitCode = 1;
    return;
  }

  await mkdir(new URL('../data/', import.meta.url), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf-8');

  if (errors.length) {
    console.warn('تم الحفظ مع تحذيرات:', errors.join(' | '));
  } else {
    console.log('تم تحديث data/rates.json بنجاح:', JSON.stringify({ USD: out.USD, EUR: out.EUR }));
  }
}

main();
