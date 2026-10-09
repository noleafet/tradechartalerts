# TradeChartAlert — market alerts

This project implements persistent Django + PostgreSQL backend, a Next.js dashboard with a live candlestick/volume chart, and Django management commands that check public market data independently of an open browser. The dashboard features exchange data pull (from Binance as default), a database-backed watchlist, dark mode, SMA/EMA/MACD overlays, Heikin Ashi, editable drawing tools and line alerts, browser notifications/sound, persistent price and MACD alerts. Chart preferences and drawings remain browser-local; alerts, trigger history, selected exchange, and watchlist symbols are stored by Django.

## Architecture

- `frontend/`: Next.js App Router + TypeScript + Tailwind CSS dashboard.
- `backend/`: Django REST Framework API and alert evaluator.
- PostgreSQL stores `Alert` rules, `TriggerEvent` history, the selected exchange, and `WatchlistSymbol` entries. SQLite is used automatically only when `DATABASE_URL` is absent (convenient for tests/local experimentation).
- Exchange public REST endpoints provide price quotes and candles. No exchange credentials or trading permissions are used.
- `check_alerts` evaluates active alerts once; `run_alerts` schedules recurring checks alongside the API process inside the backend container using APScheduler.
- Exchange selection, exchange URL, request timeout, polling interval, and Telegram credentials are stored in the `AppConfiguration` database table. Telegram credentials are managed by staff in Django admin and are never sent to the browser.

## Requirements

- Python 3.11+
- Node.js 20+
- Docker and Docker Compose (or a separately managed PostgreSQL 14+ instance)

## Docker Compose setup (recommended)

Docker Compose starts PostgreSQL, the Django API with its alert scheduler, and the Next.js frontend. The backend applies database migrations before Supervisor starts both the API and APScheduler process. The scheduler checks immediately, then polls according to `alert_poll_seconds` from Django admin. It reloads the setting after each check and reschedules automatically if it changes. Supervisor restarts either process if it exits.

```sh
cp .env.example .env
docker compose up --build -d
```

Open the dashboard at `http://localhost:3000`, the API at `http://localhost:8000/api/`, and health at `http://localhost:8000/api/health/`. Follow logs with `docker compose logs -f backend frontend`; both API and alert worker logs appear under `backend`. Stop the stack with `docker compose down`. Database data is kept in the `postgres_data` named volume; `docker compose down -v` also deletes that data.

The backend container runs `python manage.py run_alerts` under Supervisor as the recurring scheduler. Each run queries active alert rules, gets exchange data, processes conditions, writes triggered events to PostgreSQL, and sends enabled Telegram notifications from Django. To run an additional one-off check, use `docker compose exec backend python manage.py check_alerts`. Set `DJANGO_SUPERUSER_USERNAME`, `DJANGO_SUPERUSER_EMAIL`, and a strong `DJANGO_SUPERUSER_PASSWORD` in `.env` before starting the stack to create the initial admin account automatically; startup will not reset an existing account. Without a configured username and password, account creation is skipped. Then visit `http://localhost:8000/admin/`. Open **Alert configuration** (direct URL: `http://localhost:8000/admin/alerts/appconfiguration/`) to edit exchange URL, exchange timeout, alert poll seconds, Telegram bot token/chat ID, and the Telegram delivery switch. Use the protected **Find my Telegram chat ID** action there. The dashboard provides blank ad-hoc bot-token and chat-ID fields, **Find my chat ID**, and **Test Telegram** actions through Django’s CSRF-protected API. These actions do not require an admin session and never persist the submitted test credentials. The admin form also has a protected **Send test Telegram message** action. The configured bot token is shown as a password field; leaving it blank preserves the saved token. The browser only displays backend delivery status and never handles configured alert-delivery credentials.

Compose reads root `.env` automatically. Set `DJANGO_SECRET_KEY`, `POSTGRES_PASSWORD`, `FRONTEND_URL`, and `BACKEND_URL` there for your environment. Django derives its CORS and CSRF trusted origins from the frontend and backend URLs. The frontend calls the API through a same-origin `/api/proxy` rewrite, so browser requests do not need cross-origin CORS access. For native development, `frontend/.env.local` sets `BACKEND_URL=http://localhost:8000`. The Next.js rewrite is generated at build time, so provide the backend URL as the `BACKEND_URL` Docker build argument when building the frontend image.

To override published ports, set `FRONTEND_PORT` and/or `BACKEND_PORT` in `.env`. To run only PostgreSQL for native development, use `docker compose up -d db`.

## Native local setup

### 1. Start PostgreSQL

From the repository root:

```sh
docker compose up -d db
```

The development container creates database `tradechartalert` with user/password `tradechartalert` / `tradechartalert_dev` on port 5432. Do not reuse these credentials outside local development. Existing installations with a populated `postgres_data` volume are not renamed by changing defaults; keep the existing database environment values or migrate the database deliberately before switching names.

### 2. Configure Django

```sh
cp .env.example .env
cd backend
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python manage.py migrate
python manage.py runserver
```

The API is available at `http://localhost:8000/api/`. Check `http://localhost:8000/api/health/` for the health response. Admin is at `http://localhost:8000/admin/`. To bootstrap an admin automatically in native development, export `DJANGO_SUPERUSER_USERNAME`, `DJANGO_SUPERUSER_EMAIL`, and `DJANGO_SUPERUSER_PASSWORD` before running the backend startup flow, or run `python manage.py create_initial_superuser` after setting those values. The command is idempotent and leaves an existing account unchanged. You can also use Django's interactive `python manage.py createsuperuser` command.

Set the exchange and Telegram values in Django admin at `/admin/alerts/appconfiguration/`. In a second terminal, start the scheduled processor with `python manage.py run_alerts`; it uses the saved polling interval and checks immediately. Run only one scheduler process for this app instance.

### 3. Start Next.js

In another terminal, from the repository root:

```sh
cd frontend
cp .env.local.example .env.local
npm install
npm run dev
```

Open `http://localhost:3000`. The frontend proxies `/api/proxy` requests to `${BACKEND_URL}/api`; set `BACKEND_URL` in `frontend/.env.local` to change the backend target. The example points to `http://localhost:8000`.

### Run checks

```sh
# From backend, with the virtual environment active
python manage.py test
python manage.py check
python manage.py makemigrations --check --dry-run

# From frontend
npm run build
```

## Alert worker commands

Commands run in `backend/`, with the virtual environment active and database/environment configured:

```sh
# Evaluate all active alerts exactly once
python manage.py check_alerts

# Run the APScheduler process until Ctrl+C (interval comes from the Alert configuration table)
python manage.py run_alerts

# Optional fixed interval override (seconds; does not follow admin interval changes)
python manage.py run_alerts --interval 10
```

Run exactly one recurring scheduler for this app instance. Each scheduled run reads active rules from PostgreSQL, fetches current values from the configured exchange, locks and updates each alert transactionally, and saves every fired notification to `TriggerEvent`. A one-shot alert is deactivated when it fires. Repeating price alerts use a 60-second cooldown; MACD-cross alerts are checked on closed candles and are armed at the latest closed candle on first observation, so they do not replay an old cross at startup. Network/API errors are logged and retried on the next scheduled run. The backend needs outbound HTTPS access to the configured exchange; Telegram also needs outbound HTTPS access to Telegram.

## API overview

- `GET/POST /api/alerts/` — list or create alert rules.
- `GET/PATCH/DELETE /api/alerts/{id}/` — retrieve, update (including pause/resume), or delete an alert.
- `GET /api/events/` — recent trigger history.
- `GET /api/health/` — API health.

Example price rule JSON: `{"symbol":"BTCUSDT","kind":"price","condition":"cross_up","price":"68000","frequency":"once","note":"breakout"}`.

Example MACD rule JSON: `{"symbol":"ETHUSDT","kind":"macd","condition":"cross_down","timeframe":"1h","frequency":"every"}`. Supported intervals are `1m`, `5m`, `15m`, `1h`, `4h`, `1d`, and `1w`. MACD uses 12/26/9 EMA parameters seeded with an SMA, matching the calculation in the original page.

## Configuration and deployment notes

See [.env.example](.env.example) for Django, PostgreSQL, and CORS settings. Exchange URL/timeout, polling, and Telegram settings are stored in PostgreSQL and editable in Django admin. The frontend example is [frontend/.env.local.example](frontend/.env.local.example).

The API is intentionally unauthenticated for local single-user development. **Do not expose it publicly as-is.** Before deployment, add authentication/authorization and API throttling, set a strong `DJANGO_SECRET_KEY`, turn `DJANGO_DEBUG` off, configure trusted hosts/CORS and secure database credentials. Do not commit real `.env` files or Telegram tokens. The project uses exchange market data for demonstration; rate limits, temporary outages, symbol availability, and data-source terms apply.
