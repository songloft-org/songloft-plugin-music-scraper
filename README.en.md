# Music Scraper

[简体中文](README.md)

Music Scraper identifies indexed local recordings with MusicBrainz, writes high-confidence metadata to native tags, and organizes files using the selected presets. Media streams, codecs, extensions, and song IDs stay intact. Playlist membership and play history retain their original song references.

## Installation

1. Use a Songloft server with the Music Scraper bridge. The plugin checks for the required host interfaces when it opens. A `dev` build with those interfaces also works.
2. Download `music-scraper.jsplugin.zip` from [GitHub Releases](https://github.com/songloft-org/songloft-plugin-music-scraper/releases). In Songloft, open **Settings → JS Plugins**, upload the ZIP, and enable the plugin.
3. Open **Music Scraper** from the plugin menu. Lynx clients with native plugin support load the native interface. Clients that use a WebView load the Web fallback of the same interface. The fallback requires a server deployment that serves the Lynx Web runtime.
4. To use AcoustID, choose **Configure AcoustID** (设置 AcoustID) on the plugin’s opening screen, enter an application key, and save. Save an empty key to clear the setting. The opening screen shows the configuration and Chromaprint availability. Stored fingerprints can be reused, and text matching works without the key. Enabled lyric and cover providers fill in missing content. [AcoustID application keys](https://acoustid.org/webservice)

With a usable fingerprint and key, the plugin sends the fingerprint and full track duration to AcoustID. Text matching sends track metadata to MusicBrainz. Lyric and cover requests use the existing host interfaces.

## Usage

1. Select indexed folders. Selections include subfolders. Selecting a parent and one of its children processes each track once, with the parent as the organizing root.
2. Choose a folder and filename preset. By default, files stay in their folders and use `Artist-Title`. Duets use `Artist1&Artist2-Title`. You can also flatten files into the selected folder or group them by first artist and verified album under that folder. Tracks with an uncertain album stay in their existing folder when grouping by album.
3. Check the track count and example path beside **Start scraping** (开始刮削). The example uses the existing tags. The actual destination depends on the match.
4. Start scraping. High-confidence results are written automatically. Ambiguous versions appear under **Needs review** (待确认). Open a result to see its full path, credited artists, album, version, and duration. Select **Write this version** (写入此版本) beside a candidate to apply it to that track.

Refreshing reconnects to a running job. The latest saved results remain available after a plugin reload or server restart. A job still running when the plugin reloads is marked interrupted. Starting a new job replaces the previous results. Cancelling keeps completed writes. The results report path conflicts, CUE and other shared files, changed sources, and formats whose native tags could not be edited safely. Sidecar lyrics stay available under the organized file’s name. The original sidecar is kept for any other recordings that share it. The plugin preserves manual fields recorded by the server and existing embedded lyrics and covers.

## Local development

Use Node.js 22.14+ and pnpm 9.15.0. Run these commands from this directory.

```sh
pnpm install --frozen-lockfile
npm run dev
```

The dev command connects to `http://localhost:58091` by default. Use `npm run dev -- --host http://localhost:58191` to target a different instance. After the first login, the toolchain builds, uploads, and enables the plugin. It then watches the backend and Lynx frontend sources and uploads a new build after changes. Development login settings are saved locally in `.songloft-dev.json`.

The plugin’s QuickJS backend handles matching, Chinese conversion, organization presets, and job state. The host bridge provides library queries, per-track fingerprints, lyric and artwork provider lookups, and tag writes and moves with source-file checks. The plugin keeps AcoustID settings and job results in its host storage.

## Build from source

Use Node.js 22.14+ and pnpm 9.15.0. Run these commands from this directory. The output is `dist/music-scraper.jsplugin.zip`.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm validate
```

Code pushes to `main` trigger a GitHub Actions build that validates the Linux-built QuickJS bytecode, native Lynx interface, and Web fallback. The workflow provides the ZIP artifact. To publish a GitHub Release, run **Package Plugin** on `main` with `publish` selected. Releases use `year.month.day.sequence` in the Asia/Shanghai time zone and record the source commit, download URL, and integrity hashes in the manifest.
