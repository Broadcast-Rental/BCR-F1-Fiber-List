# F1 Fiber & Joinbox Manager

The page is served from a small Node server. Race data is stored in a Docker volume, uploaded photos are files on that volume, and open browsers stay in sync over a websocket.

## Run

```bash
docker compose up -d --build
```

Open `http://localhost:8080`.

The first browser that opens an empty server uploads the copy saved in that browser. After that, everyone shares the server copy.

Data survives restarts in the `f1-fiber-data` volume. To keep a copy on the host instead:

```yaml
volumes:
  - ./data:/data
```

## Local development

```bash
npm install
npm start
```
