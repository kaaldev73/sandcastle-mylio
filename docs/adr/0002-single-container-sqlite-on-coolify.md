# One container with SQLite and a mounted volume, deployed on Coolify

The app runs as a single container holding the web app and a SQLite database (WAL mode), with originals and the database on one persistent volume. We chose this over Postgres because family-scale concurrency doesn't need it and it keeps deployment to one service; the cost is that backups must cover the volume and scaling out later means a migration. Scheduled off-box volume backup is part of v1.
