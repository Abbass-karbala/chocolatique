# Chocolatique: business app + online store

One small Node app (no build step, no database server) with two parts:

- **The store** (`/`): English + Arabic catalog. Customers add to cart and the order is saved and sent to your WhatsApp.
- **The app** (`/admin/`): works on phone, tablet and laptop (install it from the browser menu: "Add to Home Screen"). Sales, purchases, customers, suppliers, cost control, recipes, reports.

## Run it

```
npm install
npm start            # http://localhost:3000  (store)   http://localhost:3000/admin/  (app)
npm test             # 17 tests (cost maths + API)
SEED_DEMO=1 npm start   # with a demo customer, invoice and purchase
```

Needs Node 22.5+. Data lives in `../data/` (SQLite file + uploaded photos). **Back that folder up.**

## First login: change the password!

Default user is **admin / admin** (the app nags you until you change it, and refuses "admin" as a new password).
Settings → *Change my password*. Settings → *Users* creates more users:

| Role | Can do |
|---|---|
| Admin | everything |
| Staff | orders, sales invoices, customers only (no purchases, costs, reports, settings) |

Forgot the password? Start the server once with `ADMIN_PASSWORD=newpass npm start`.

## How cost control works

1. **Ingredients** each have a unit (kg, g, L, ml, pcs) and a *cost control price*.
2. **Products** have a recipe for one batch (e.g. 100 sablé: flour 5 kg, butter 2.5 kg …). A product can contain other products (gift box = 3 bonbons + box: set "pieces per batch" to 1 and list what goes in one box).
3. Cost per piece and per batch = recipe + waste + packaging + labor + overhead + distribution (same formulas as your Excel).
4. When you save a **purchase**, the ingredient's *last purchase price* is recorded, but cost control does **not** change by itself.
   You get a prompt: **Update cost control**: a window shows each ingredient before → after and each product's cost and margin before → after. Press *Apply* to accept.
5. No stock tracking (by design, for now).

## Orders

Website orders ring the app (sound + message + red counter on *Orders*, checked every 20 s while the app is open).
WhatsApp/phone orders: *Orders → + New order*. Mark an order **Delivered** and it becomes a paid invoice for that customer (cash on delivery).

## Invoices, customers, suppliers

Sales invoices and purchases have lines, payments and a status (Paid / Partial / Unpaid). Each customer/supplier has a balance and a statement; *Receive payment* / *Pay supplier* is applied to the oldest unpaid invoices first. Invoices open as a clean printable page (Print / Save as PDF) and can be sent via **WhatsApp**.

## Recipes: printing

Product → *Print recipe*: choose number of batches (scales every quantity) and the layout: quantities only (kitchen sheet), with prices and line costs, or with a cost summary. Admin only.

## Reports (Reports menu; date filter, Print, CSV for Excel)

Sales (by product / customer / channel / month / day / invoice) · Customers · Unpaid sales (aging) · Purchases (by supplier / ingredient / month / day / invoice) · Suppliers · Unpaid purchases · Goods & ingredient price changes · Profit by product · Net profit · Expenses · Income · Cash flow · Journal · Monthly results (full monthly sheet) · Customer and supplier statements.

## Store photos

The server downloads the 9 product photos from the existing Chocolatique site at start-up (skipped quietly if offline). They are created as **unpublished, unpriced** products: open one in *Cost control*, add a recipe and a selling price, tick *Show in the online store*.

## Settings worth checking

WhatsApp number (taken from the public site, `96171193278`: change it if wrong), Instagram, e-mail, labor rate, waste %, target margin, monthly overhead.

## Deploy notes

- `PORT`, `DATA_DIR`, `ADMIN_PASSWORD` environment variables.
- Behind HTTPS reverse proxy (nginx/Caddy): set `TRUST_PROXY=1 COOKIE_SECURE=1`.
- Login and public orders are rate-limited; passwords are scrypt-hashed; all pages escape user text; Origin check on writes.
