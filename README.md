# Wedding album

A small, self-hosted photo album for wedding guests. They scan a QR code, the album opens in
their phone's browser, and they add photos: no app to install, no account to create. Photos
show up for everyone within a few seconds, and you download the full-size originals afterwards.

Everything runs on Fly.io: the app, a small disk for the photo list, and a Tigris bucket for
the photos themselves.

## How it works

```
Guest's phone ──► Fly.io app (Node) ──► Tigris bucket          (the photos themselves)
                         │
                         └────────────► SQLite on a Fly disk    (the list of photos: who, when)
```

- The guest's phone makes the small preview images itself, then sends the untouched original,
  which the app streams straight into Tigris. The server never has to process images.
- The album updates live (every 15 seconds) and loads more as you scroll.
- Guests can remove photos they added (from the same phone). In admin mode you can remove any photo.
- Everything sits behind a guest code, which is built into the QR code so guests never type it.

### Where everything is stored

| What | Where |
| --- | --- |
| The photo files | **Tigris**, Fly.io's built-in file storage (a private bucket) |
| The list of photos: who added each one, and when | A **SQLite** database on a 1 GB Fly disk attached to the app, backed up daily (backups kept for 30 days) |
| The website itself | **Fly.io**, which runs the app |

Each photo is saved as three files in the bucket: `originals/` (the untouched full-size file),
`previews/` (1600px, for the viewer) and `thumbs/` (small, for the album grid). Guests never
reach the bucket directly: everything goes through the app, which checks the guest code.

Because the photo list lives on one disk, the app runs as a single server. That's plenty for a
wedding.

Tigris uses the standard S3 interface, so other S3-compatible storage (Cloudflare R2, Backblaze
B2, Amazon S3) should work by changing the storage settings in `.env.example`, with no code changes.

## Make it yours

| What | Where |
| --- | --- |
| Names, date, venue, wording | `public/index.html` (marked with ✎) |
| Fonts and colours | `public/theme.css`, a single file of settings |
| Upload size limit | `MAX_UPLOAD_MB` in `fly.toml` (default 50) |

To see your changes, run it on your computer. No accounts or setup are needed:

```sh
npm install
npm run dev    # then open http://localhost:8080
```

Photos you add locally are saved in the `data/` folder, which git ignores. Delete it to start
afresh.

## Put it online (about 10 minutes)

You'll need `flyctl`, signed in with `fly auth login`.

1. **Create the app.** From this folder:

   ```sh
   fly launch --copy-config --no-deploy
   ```

   Choose an app name (it becomes `https://<name>.fly.dev`) and decline any databases it
   offers; the album brings its own. The region is set to `lhr` (London) in `fly.toml`.

2. **Create the photo storage.**

   ```sh
   fly storage create
   ```

   This creates a private Tigris bucket and gives the app its keys automatically. There's
   nothing to copy.

3. **Choose your codes.** Copy `.env.example` to `.env`, fill in `GUEST_CODE` and `ADMIN_CODE`,
   then give the app the same values:

   ```sh
   fly secrets set GUEST_CODE=ALEXSAM27 ADMIN_CODE=<long random string>
   ```

   Keep the two in sync: the QR code and download commands read your `.env`, and Fly secrets
   can't be read back.

4. **Deploy.**

   ```sh
   fly deploy --ha=false
   ```

   `--ha=false` keeps it to one server, since the photo list lives on its disk. The first deploy
   creates the 1 GB disk. Then open `https://<name>.fly.dev/?code=ALEXSAM27`.

5. **Make the QR code.**

   ```sh
   npm run qr -- https://<name>.fly.dev
   ```

   This writes `qr-code.svg` (print this one), `qr-code.png`, and `qr-code-transparent.png` for
   printing straight onto a light-coloured card, all with your guest code built in.
   Scan it with an iPhone *and* an Android before printing, and print the code in small type
   underneath in case someone's camera won't scan it.

## Admin mode

Visit `/?code=<ADMIN_CODE>`. A red bar confirms it, and every photo gets a **Remove** button
in the viewer. Removing deletes the photo from storage too, so it can't be undone.

## On the day

- A day before, set `min_machines_running = 1` in `fly.toml` and `fly deploy --ha=false`, so
  nobody waits for the app to wake up. Set it back to `0` afterwards.
- Do a test upload at the venue on mobile data. Barn and marquee Wi-Fi can be patchy. Uploads
  retry automatically and resume when the signal returns, as long as the page stays open.

## Afterwards

```sh
npm run download -- https://<name>.fly.dev    # every original into ./wedding-photos
```

It signs in with the code from your `.env`. Files are named by upload time and guest, e.g.
`2027-06-12 20.41.33 Auntie Jo 1a2b3c4d.jpg`, and keep their original camera data, so photo apps
can still sort them by when they were taken. It's safe to re-run: anything already downloaded
is skipped.

Then either leave the album up for guests to browse, or, **once you've downloaded everything**,
tear it down with `fly apps destroy <name>` (the app and its disk) and
`fly storage destroy <bucket>` (the photos).

## Backups

The photos are in Tigris, which is separate from the app's disk. Fly snapshots the disk (the
photo list) every day and keeps 30 days of snapshots. `fly volumes list` shows the disk, and
`fly volumes snapshots list <volume id>` shows its backups.

## Costs

- **Tigris:** 5 GB free each month, then $0.02 per GB-month, with no download fees. A busy
  wedding (~2,000 photos) is roughly 8–10 GB, so pennies a month.
- **Fly.io:** no free tier. The app stops itself when nobody's using it and starts again on the
  next visit, so you mostly pay for the hours it runs. The 1 GB disk is about $0.15 a month,
  and its backups are free at this size. Expect a few dollars a month at most.

## Good to know

- **Photos only, no video**, up to 50 MB each.
- **iPhone photos:** when you upload from Safari, iOS converts HEIC photos to full-resolution
  JPEGs, so they display everywhere. A HEIC file uploaded from a laptop or Android browser
  still saves at full quality, but shows as a placeholder tile in the album.
- **Avoid "free" QR code websites.** Many make *dynamic* codes that redirect through their
  servers and stop working unless you subscribe. `npm run qr` makes a static code that never
  expires.

## Files

- `server/`: the API (Hono), the SQLite photo list and storage
- `public/`: the page guests see
- `scripts/`: `qr.js` and `download.js`
