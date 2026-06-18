# CrowdCab Pickup Guidance MVP

CrowdCab is a web-based pickup guidance prototype for crowded event exits. The project helps riders choose safer and more practical cab pickup points after a large event by combining venue data, walking distance, congestion indicators, accessibility, safety, and driver access.

The purpose of the MVP is not to build a full ride booking, payment, or driver dispatch platform. The main problem it solves is:

```text
Where should a rider walk to get a cab more easily after an event?
```

The app provides a customer-facing pickup map and internal operational dashboards. It uses local CSV seed data and SQLite database automatically when the app starts.

## Features

- Event pickup guidance with ranked pickup point recommendations.
- Live map showing venues, pickup points, congestion context, available cabs, and walking routes.
- Recommendation priorities such as best overall, fastest walking option, less crowded option, and accessible option.
- GPS-style walking guidance page for the selected pickup point.
- Customer trip history for confirmed pickup plans.
- Email OTP login flow for customers, with local demo fallback when SMTP is not configured.
- Password-protected internal access for admin/developer views.
- Internal dashboards for demand, allocations, system data, and API health.
- Local fallback traffic model so the app still works without live traffic API keys.
- Open-data, QLDTraffic, and TomTom traffic configuration through environment variables.

## Project Structure

```text
crowdcab_right_guidance_build-2/
|-- app.py
|-- recommendation_engine.py
|-- realtime_traffic.py
|-- requirements.txt
|-- .env
|-- .env.example
|-- README.md
|-- data/
|   |-- bookings.csv
|   |-- cab_allocations.csv
|   |-- candidate_pickup_points.csv
|   |-- congestion_points.csv
|   |-- road_network_points.csv
|   |-- venues.csv
|   `-- venue_pickup_points.csv
|-- static/
|   |-- favicon.svg
|   |-- css/
|   |   `-- styles.css
|   `-- js/
|       |-- booking.js
|       |-- dashboard.js
|       |-- guidance.js
|       |-- main.js
|       |-- map.js
|       `-- my_trips.js
`-- templates/
    |-- allocations.html
    |-- base.html
    |-- dashboard.html
    |-- dashboard_hub.html
    |-- guidance.html
    |-- home.html
    |-- how_it_works.html
    |-- internal.html
    |-- login.html
    |-- map.html
    |-- my_trips.html
    |-- safety.html
    `-- system.html
```

Important files:

- `app.py` contains the Flask routes, JSON APIs, authentication flow, and database seeding.
- `recommendation_engine.py` contains pickup scoring and ranking logic.
- `realtime_traffic.py` handles live traffic providers and fallback traffic scoring.
- `data/` contains the CSV files required to seed and run the app.
- `templates/` contains the HTML pages rendered by Flask.
- `static/` contains the CSS, JavaScript, and favicon used by the frontend.
- `.env.example` is the safe environment configuration template.

## How To Setup The Project

These steps assume you received the project as a zip file.

1. Extract the zip file.

Extract the folder to a location on your computer, then open a terminal inside the extracted project folder:

```text
crowdcab_right_guidance_build-2
```

2. Create a Python virtual environment.

Windows PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

macOS/Linux:

```bash
python3 -m venv .venv
source .venv/bin/activate
```

3. Install the required packages.

```bash
pip install -r requirements.txt
```

4. Create the local environment file.

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

macOS/Linux:

```bash
cp .env.example .env
```

5. Check the environment settings.

The app can run with the default values from `.env.example`. API keys are optional for local testing.

Useful settings:

```text
ENABLE_REALTIME_TRAFFIC=True
REALTIME_PROVIDER=open_data
INTERNAL_ACCESS_PASSWORD=Crowdcab
FLASK_DEBUG=False
```

Optional traffic keys:

```text
QLDTRAFFIC_API_KEY=your_qldtraffic_api_key_here
```

Optional email settings:

```text
SMTP_HOST=
SMTP_PORT=587
SMTP_USERNAME=
SMTP_PASSWORD=
SMTP_FROM_EMAIL=
```

If SMTP is not configured, the app still runs in local demo mode and shows/logs the OTP for testing.

6. Start the app.

```bash
python app.py
```

7. Open the app in a browser.

```text
http://127.0.0.1:5000
```

## Login And Access

Customer login:

```text
Use any valid email address and complete the OTP flow.
```

Internal access:

```text
Admin:     admin@crowdcab.com
Developer: dev@crowdcab.com
Password:  Crowdcab
```

## Useful Pages

```text
/                       Home page
/map                    Live pickup map
/guidance               Walking guidance page
/my-trips               Customer trip history
/login                  Login page
/internal               Internal tools home
/internal/dashboard     Dashboard hub
/internal/allocations   Cab allocation view
/internal/system        System and dataset overview
```

## Data And Runtime Notes

- The app uses the CSV files in `data/` as required seed/reference data.
- `data/crowdcab.sqlite` is generated automatically when the app runs.
- Python cache folders such as `__pycache__/` are generated automatically and are not required in the submitted zip.
- `.env` is local configuration and should be created from `.env.example` after extraction.
