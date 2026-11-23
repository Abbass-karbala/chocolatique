'use strict';
// First-run data: settings, the two real products with recipes, photo products from the Chocolatique site, optional demo data.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { db, tx, DATA_DIR } = require('./db');
const { SETTING_DEFS } = require('./settings');
const { today } = require('./util');

const SITE = 'https://chocolatique-site.shop.erp.kalousystems.com';
// slug, EN name, AR name, EN category, AR category
const PHOTOS = [
  ['sable', null],
  ['bonbons', ['Chocolate Bonbons', 'بونبون شوكولاتة', 'Gifts', 'هدايا']],
  ['birthday-box', ['Birthday Box', 'بوكس عيد ميلاد', 'Birthday', 'عيد ميلاد']],
  ['ramadan-dates', ['Ramadan Chocolate Dates', 'تمر بالشوكولاتة رمضان', 'Ramadan and Eid', 'رمضان والعيد']],
  ['christmas-egg', ['Christmas Chocolate Egg', 'بيضة شوكولاتة الميلاد', 'Christmas', 'الميلاد']],
  ['date-bites', ['Date Bites', 'قضمات التمر', 'Ramadan and Eid', 'رمضان والعيد']],
  ['chocolate-bomb', ['Hot Chocolate Bomb', 'قنبلة الشوكولاتة الساخنة', 'Gifts', 'هدايا']],
  ['coconut-balls', ['Coconut Balls', 'كرات جوز الهند', 'Gifts', 'هدايا']],
  ['tres-leches', ['Tres Leches Cup', 'تريس ليتشي', 'Desserts', 'حلويات']],
];

function seed() {
  const st = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
  for (const [k, d] of Object.entries(SETTING_DEFS)) st.run(k, String(d.d));

  if (!db.prepare('SELECT 1 FROM products').get()) tx(() => {
    const ins = db.prepare(`INSERT INTO products(name_en,name_ar,desc_en,desc_ar,category,category_ar,image,pieces_per_batch,hours_per_batch,price,distribution,published,sort)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    ins.run('Chocolate Sablé', 'سابليه الشوكولا', 'Buttery shortbread with real Belgian chocolate.', 'بسكويت سابليه بالزبدة مع شوكولا بلجيكية حقيقية.', 'Cookies', 'كوكيز', '/uploads/seed/sable.webp', 100, 7, 1, 0.1, 1, 1);
    ins.run('Protein Cookies', 'كوكيز البروتين', 'High-protein cookies.', 'كوكيز غني بالبروتين.', 'Cookies', 'كوكيز', '', 10, 0.2, 2, 0.14, 1, 2);
    let n = 3;
    for (const [slug, m] of PHOTOS) if (m) ins.run(m[0], m[1], '', '', m[2], m[3], `/uploads/seed/${slug}.webp`, null, null, null, null, 0, n++);

    const g = db.prepare('INSERT INTO ingredients(name_en,name_ar,unit,kind,cost) VALUES(?,?,?,?,?)');
    const id = (...a) => Number(g.run(...a).lastInsertRowid);
    const flour = id('Flour', 'طحين', 'kg', 'ingredient', 0.9), butter = id('Butter', 'زبدة', 'kg', 'ingredient', 6), sugar = id('Sugar', 'سكر', 'kg', 'ingredient', 1),
      choc = id('Belgian chocolate', 'شوكولا بلجيكية', 'kg', 'ingredient', 3.75), box = id('Box / bag', 'علبة / كيس', 'pcs', 'packaging', 0.06),
      whey = id('Protein powder', 'بروتين باودر', 'kg', 'ingredient', 12), oats = id('Oats', 'شوفان', 'kg', 'ingredient', 2), pb = id('Peanut butter', 'زبدة الفستق', 'kg', 'ingredient', 5);
    const rl = db.prepare('INSERT INTO recipe_lines(product_id,ingredient_id,qty) VALUES(?,?,?)');
    for (const [i, q] of [[flour, 5], [butter, 2.5], [sugar, 2], [choc, 2], [box, 100]]) rl.run(1, i, q);
    for (const [i, q] of [[whey, 0.3], [oats, 0.5], [pb, 0.4], [box, 10]]) rl.run(2, i, q);
  });

  if (process.env.SEED_DEMO === '1' && !db.prepare('SELECT 1 FROM customers').get()) tx(() => {
    const t = today(), m = t.slice(0, 7);
    const c = Number(db.prepare("INSERT INTO customers(name,phone,created_at) VALUES('Maya Haddad','+96170111222',?)").run(t).lastInsertRowid);
    const s = Number(db.prepare("INSERT INTO suppliers(name,phone,created_at) VALUES('Souk Wholesale','+9613000111',?)").run(t).lastInsertRowid);
    const inv = Number(db.prepare("INSERT INTO invoices(customer_id,date,channel) VALUES(?,?,'Shop')").run(c, `${m}-03`).lastInsertRowid);
    db.prepare("INSERT INTO invoice_lines(invoice_id,product_id,name,qty,price) VALUES(?,1,'Chocolate Sablé',200,1)").run(inv);
    db.prepare("INSERT INTO payments(doc_type,doc_id,date,amount) VALUES('sale',?,?,120)").run(inv, `${m}-05`);
    const pu = Number(db.prepare('INSERT INTO purchases(supplier_id,date) VALUES(?,?)').run(s, `${m}-02`).lastInsertRowid);
    db.prepare('INSERT INTO purchase_lines(purchase_id,ingredient_id,qty,total) VALUES(?,3,10,10)').run(pu);
    db.prepare("INSERT INTO payments(doc_type,doc_id,date,amount) VALUES('purchase',?,?,10)").run(pu, `${m}-02`);
    db.prepare("INSERT INTO expenses(date,description,category,amount) VALUES(?,'Gas bottle','Gas',20)").run(`${m}-04`);
  });
}

// Download product photos from the Chocolatique site in the background; silent if the network is not available.
function downloadSeedImages() {
  const dir = path.join(DATA_DIR, 'uploads', 'seed');
  fs.mkdirSync(dir, { recursive: true });
  for (const [slug] of PHOTOS) {
    const file = path.join(dir, `${slug}.webp`);
    if (fs.existsSync(file)) continue;
    const req = https.get(`${SITE}/ig/${slug}.webp`, { timeout: 8000 }, (res) => {
      const ok = res.statusCode === 200 && /image/.test(res.headers['content-type'] || '');
      if (!ok) { res.resume(); return; }
      const chunks = []; let size = 0;
      res.on('data', (d) => { size += d.length; if (size > 3e6) req.destroy(); else chunks.push(d); });
      res.on('end', () => { if (size && size <= 3e6) fs.writeFile(file, Buffer.concat(chunks), () => {}); });
    });
    req.on('error', () => {}); req.on('timeout', () => req.destroy());
  }
}

module.exports = { seed, downloadSeedImages };
