# Tailored by Kyla

Website, customer accounts and a private seller studio for **Tailored by Kyla** (Pakil). It covers renting, buying and commissioning gowns.

- **Public site**: an editorial home page, a lookbook-style collection with filters, gown pages with a rental calendar, a gallery with a full-screen viewer, a commission form and an atelier page.
- **Customer account**: rentals, purchases, custom orders, wishlist, messages, notifications and account settings.
- **Studio** (`/studio`, administrators only): gown listings and photographs (with optional background removal), availability, rental, order and commission workflows, messages, customers, categories and settings.

Stack: Node.js 22.13+ (tested on 24), Express 4, Nunjucks templates, SQLite through Node's built-in `node:sqlite`, and sharp for images. There's no front-end build step and no paid service.

---

## 1. Quick start (local)

```bash
npm install
npm run brand:assets     # fonts + logo variants from logo.jpg (already generated; rerun if the logo changes)
npm run migrate          # creates data/tailored-dev.db
npm run create-admin     # Kyla's studio account (see §3)
npm start                # http://localhost:3000
```

Optional sample data for trying the layouts (**development only**, refused in production):

```bash
npm run seed:dev -- --reset
```

The seed adds eight listings named "Sample No. 01–08". Their "photographs" are labelled test plates, not gowns. It also creates two test accounts with random passwords, printed once. While `NODE_ENV` isn't `production`, a corner badge marks the site as a development environment.

Run the automated workflow tests (they use a throwaway database):

```bash
npm test
```

## 2. Database & migrations

- SQLite file: `data/tailored.db` in production, `data/tailored-dev.db` otherwise. Override it with `DATABASE_FILE`.
- Schema: `server/migrations/*.sql`, applied in order. They're recorded in the `schema_migrations` table.
- `npm run migrate` applies pending migrations. The server also applies them automatically when it starts.
- To change the schema, add a new file such as `002_add_x.sql`. Never edit a migration that has already run.
- **Back up** the database file and the `storage/` folder together. A consistent copy while running: `sqlite3 data/tailored.db ".backup backup.db"`, or stop the server and copy both.

Main tables: `users` (role `customer` | `admin`), `sessions`, `gowns`, `gown_images`, `gown_units` (one row per physical piece), `availability_blocks`, `rentals`, `orders`, `custom_requests`, `custom_request_images`, `quotations`, `threads`, `messages`, `notifications`, `status_events` (full status history), `wishlist`, `settings`, `categories`.

## 3. Creating the first administrator

The website never grants studio access. Registration always creates customers, and roles are only read from the database on the server. Create Kyla's account from the server's command line:

```bash
npm run create-admin
# or non-interactively:
npm run create-admin -- --email kyla@example.com --name "Kyla"
```

The password is typed with hidden input, minimum 10 characters. For unattended deploys you can set `ADMIN_EMAIL`, `ADMIN_NAME` and `ADMIN_PASSWORD` once, run the command, then remove them.

Other options:
- To promote an existing customer account, run the same command with its email. It asks for confirmation.
- To reset an administrator's password: `npm run create-admin -- --email … --reset-password`.

Sign in at `/login`; administrators are taken to `/studio`.

## 4. Environment variables

See `.env.example`. Copy it to `.env`, which is loaded automatically. None are secret apart from `ADMIN_PASSWORD`, which you should remove after use.

| Variable | Purpose |
|---|---|
| `NODE_ENV` | `production` turns on secure cookies, HSTS and template caching |
| `PORT`, `BASE_URL` | Listening port and public address |
| `TRUST_PROXY` | Set to `1` behind a reverse proxy / platform load balancer (required for secure cookies over HTTPS) |
| `DATABASE_FILE`, `STORAGE_DIR` | Where the database and uploaded images live (use a persistent disk) |
| `SESSION_DAYS` | Sign-in lifetime (default 14) |
| `UPLOAD_MAX_MB` | Maximum size per photograph (default 12) |
| `REMBG_PATH`, `REMBG_MODEL`, `REMBG_ALPHA_MATTING` | Optional background removal (see §6) |
| `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD` | Only for unattended `create-admin` |

## 5. Deployment

Any host that runs a persistent Node process with a writable disk will work, for example a small VPS, Render or Railway with a disk, or Fly.io with a volume. SQLite needs a disk that survives restarts.

```bash
NODE_ENV=production TRUST_PROXY=1 npm ci --omit=dev
NODE_ENV=production npm run migrate
NODE_ENV=production npm run create-admin
NODE_ENV=production npm start
```

- Put it behind HTTPS (Caddy or Nginx, or the platform's TLS). Cookies are `Secure` in production, so plain HTTP sign-in won't work.
- Keep it running with a process manager (systemd, pm2) or the platform's.
- Point `DATABASE_FILE` and `STORAGE_DIR` at the persistent volume.
- Housekeeping runs hourly inside the server. It sends pickup and return reminders and clears expired sessions.

## 6. Photographs & background removal

**The photographs.** Facebook couldn't be read automatically (it requires sign-in), so the photographs come from the project's `assets` folder. Nothing is stock or generated.

```
assets/
├── originals/        the files as supplied — never modified
├── processed/        per category, e.g. gowns/evening-gowns/, menswear/pageant-formalwear/, costumes/
│     <name>.png          transparent master (cut-out)
│     <name>-studio.jpg   the cut-out on the shared ivory studio canvas (1600×2000)
│     <name>-detail-N.jpg close-up crops of embroidery and beadwork
├── backgrounds/consistent-product-background.png   the shared studio canvas
├── review.json       the image-by-image review: what each photograph shows, its category, title, notes, showcase choice
└── manifest.json     generated: original path, processed paths, category, background-removal status, notes
```

**Workflow for the asset folder**

1. Put new photographs in `assets/originals/` and describe each one in `assets/review.json`: its category, a title, whether to publish it, and any notes. If a photograph is ambiguous, give it the `unclassified` category so it is held for manual review instead of being guessed. Exact and near duplicates are detected and reported.
2. `npm run assets:organize` removes the backgrounds and writes `manifest.json`. It always works from the original and reuses an existing cut-out for the same source bytes, so nothing is processed twice. `-- --force` redoes them.
3. Check the outputs in `assets/processed/` against the originals: hems, trains, tulle, fringe and hair. If a cut-out isn't good enough, mark it in the review so the original photograph is used instead.
4. `npm run assets:import` loads the manifest into the website. Every photograph becomes a **library** image. Each garment becomes a listing in its category, published or draft as the review says. The homepage showcase is filled from the review. It is safe to rerun: images are matched by SHA-256 and listings by their source file, so Kyla's edits are kept. **No prices, sizes or materials are created.** Listings offer made-to-order enquiries until Kyla adds rental or purchase details.

Current set: 13 files reviewed. 12 garments were cut out (8 women's gowns, 2 menswear sets, 2 costumes), and 4 close-ups were cropped. `logo.jpg` is the brand mark and isn't shown as a garment. *Heritage Pageant Costume* stays a draft: it is a school-event portrait with a student's name on it, and needs the student's and school's consent before publishing.

**In the studio**

- **Photo library** (`/studio/library`) lets Kyla browse every photograph by category, compare the original, cut-out and studio versions, and upload new photographs, with background removal applied straight away when it's configured. She can tick photographs and either *start a new draft listing* or *add them to an existing listing*. A photograph can be used by several listings. Removing it from a listing keeps it in the library, and the library only deletes files nothing uses.
- **Gowns → a listing → Photographs**: Kyla can upload here too; uploads also go into the library. For each photograph she chooses **Studio canvas** (the house look), **Cut-out on a backdrop** or **Full frame**, and can remove or redo the background.
- **Homepage** (`/studio/showcase`) sets the showcase: one *masterpiece* (the cover and its own spread), then the *signature pieces* in order, each with a choice of photograph and an optional line of text. Each listing also has a *Homepage* box. Only published gowns ever appear on the homepage.
- **Categories** each belong to a section (women's gowns, menswear, costumes, other). Sections drive the homepage's *Explore by collection* and `/collection?section=…`. A listing's category is changed on the listing itself.

**Background removal** uses [rembg](https://github.com/danielgatis/rembg) (MIT). It runs locally, with no API or fees.

```bash
python -m venv .venv-rembg
.venv-rembg/Scripts/pip install "rembg[cpu,cli]"   # Linux/macOS: .venv-rembg/bin/pip
# .env
REMBG_PATH=C:…Tailored by Kyla.venv-rembgScriptsembg.exe
REMBG_MODEL=birefnet-general-lite      # gave the cleanest edges on these photographs
```

Without `REMBG_PATH`, the studio says so plainly and keeps photographs as originals. It never produces a fake cut-out. The original is never altered, so a cut-out that damages tulle or a train can always be discarded.

## 7. How the workflows behave

**Rentals.** The customer picks the event date, then pickup and return, on a calendar that greys out unavailable days (`/api/gowns/:id/availability` returns dates only). A request **does not hold dates**. When Kyla approves, the server assigns a free physical piece inside a write-locked transaction. Overlapping approvals for the same piece are impossible, and concurrent clicks are covered by a test. Approved requests on gowns with a deposit stay *Approved — deposit due* until Kyla records the deposit; this can be switched off in Settings. Then the rental moves to *Confirmed*, *With you* (picked up), *Returned* (with condition and damage notes) and *Completed*. Turnaround days between rentals, the online cancellation window and the booking horizon are set in Settings. Kyla can block dates per gown or per piece.

**Purchases.** These are *order inquiries*. **No payment is taken on the site** and no card data is collected. Kyla confirms availability, which reserves a piece so it can't be sold or rented twice. The customer sees the payment instructions from Settings. Kyla marks payment *verified* only after receiving it herself. An order can't be completed before that.

**Custom gowns.** The request carries measurements and inspiration images, which only the customer and the studio can see. Kyla sends a quotation (revisions supersede the previous one), and the customer accepts or declines it. Acceptance moves the request to *Awaiting approval*. Kyla can only approve after a quotation has been accepted. The remaining statuses are *In progress*, *Ready for fitting* and *Completed*. The agreed measurements, design notes, fitting date and deadline are stored on the request.

**Messages and notifications.** Each rental, order or commission has its own conversation, and customers can also ask about a specific gown or send a general question. Every status change creates an in-app notification and an entry in the history timeline.

## 8. Security notes

- Passwords are hashed with scrypt (N=32768). Sessions are random 256-bit tokens, stored only as SHA-256 hashes, in `HttpOnly`, `SameSite=Lax` cookies that are `Secure` in production.
- CSRF protection uses a double-submit token on every POST, multipart forms included.
- Role checks happen on the server for every `/studio` route. Customer queries are always scoped to the signed-in user, and other customers' records return 404.
- Uploads must decode as real images (JPEG, PNG, WebP, AVIF, TIFF or GIF), with a size limit. They're re-encoded and get random file names. Inspiration images are served only to their owner and the studio, with `no-store`. Draft gown photos are private until published.
- Login and registration are rate limited.
- A strict Content-Security-Policy is set: scripts only from this site, no inline scripts. There are no third-party requests, and fonts are self-hosted.
- Temporary passwords: without email configured, Kyla can set a one-time temporary password for a customer (Studio → Customers). It's shown once and signs the customer out everywhere.

## 9. Status of features and integrations

**Implemented and covered by `npm test`:**
- Customer registration and login.
- Role separation, including escalation attempts.
- CSRF protection.
- Gown creation, photo upload and validation, and publishing.
- Rental request, approval, deposit and confirmation, with double-booking prevention including concurrent approvals.
- Pickup and return with a damage record.
- Purchase inquiry, piece reservation, payment verification and completion.
- Custom request with private images, quotation, acceptance and approval.
- Messaging privacy, wishlist and output escaping.
- One sign-in page for every role, with each role always landing in its own area.
- Help signing in: request, studio temporary password, and a forced password change.
- Photo library, new listings from the library, collection sections and the homepage showcase.

**Not configured — needs setting up before use:**
- **Email notifications.** Not implemented. Notifications appear only on the website, and customers are pointed to the official Facebook page for anything urgent. All notifications go through `server/lib/notify.js` (`notify()` / `notifyStudio()`), which is the place to add an SMTP or transactional-email provider later.
- **Online payments.** Not implemented by design; orders are inquiries. If a gateway such as PayMongo or Xendit is added later, use its hosted checkout and verify payment through its signed webhooks before setting `payment_status = 'verified'`.
- **Background removal.** Optional. It needs rembg installed and `REMBG_PATH` set (see §6).
- **Password reset by email.** Needs email. Until then, *Forgotten your password?* on the sign-in page sends a request to the studio, without revealing whether the account exists. Kyla checks it's really the customer, then sets a temporary password from *Customers*. The customer has to choose their own password the next time they sign in.
- **Content Kyla should supply:** gown photographs, prices, sizes, policies and terms, payment instructions, an "about" text, hours, and Messenger, Instagram, email or phone if she wants them shown. Only the brand name, *Pakil* and the Facebook page link were verifiable, so nothing else is pre-filled.

## 10. Project layout

```
server/            Express app, routes, models, libraries, SQL migrations
  routes/studio/   Seller dashboard (admin only)
views/             Nunjucks templates (layouts, public, account, studio)
public/            CSS, JS, fonts, brand images (served at /static)
scripts/           migrate, create-admin, seed-dev, images:process, brand:assets, assets:organize, assets:import
test/              workflow tests (npm test) and smoke.js
data/, storage/    database and uploaded images (git-ignored; back up)
```
