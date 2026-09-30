# Random TV

A Stremio addon that shows 10 random movies, like flicking through movie channels. Nothing to browse or decide on: open **Random Movie (changes through the day)** on your Board and pick something.

## How it works

- There are **10 channels**. Each one plays films back to back on a fixed schedule, using each film's runtime to work out when the next one starts.
- Channels change one at a time as their film ends, so the lineup shifts gradually through the day instead of all at once.
- Each channel draws from its own slice of the film pool, so the same film is never on two channels at once.
- Schedules are worked out from the clock, not stored anywhere. The lineup is the same after a restart or refresh.
- Films come from [Cinemeta](https://v3-cinemeta.strem.io)'s top movies (default pool of 2,000). Shorts and films under 75 minutes are skipped.

The addon only provides the catalog and film details. Streams come from whichever stream addons you already have installed in Stremio.

**Limitation:** Stremio has no way for an addon to start playback partway through, so a film always plays from the beginning.

## Run it locally

Requires Node.js 18 or newer.

```
npm install
npm start
```

Then add `http://127.0.0.1:7000/manifest.json` in Stremio's Addons search box.

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `7000` | Port the addon listens on |
| `POOL_SIZE` | `2000` | How many of Cinemeta's top movies to draw from. Larger means more variety but more obscure films |

## Hosting

Stremio needs an HTTPS address for remote addons. This project deploys to [BeamUp](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/deploying/beamup.md), Stremio's free addon hosting:

```
npm install beamup-cli -g
beamup config
beamup
```

The project folder name becomes the app name, so it must be lowercase letters, numbers and `-`.

## Built with

[stremio-addon-sdk](https://github.com/Stremio/stremio-addon-sdk)
