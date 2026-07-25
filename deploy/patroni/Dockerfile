# Patroni + PostgreSQL 16 + pgvector image for on-premises HA deployment
FROM postgres:16-bookworm

# Install Patroni + dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-psycopg2 \
    postgresql-16-pgvector \
    && pip3 install --break-system-packages patroni[kubernetes] \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy Patroni config and init scripts
COPY patroni.yaml /etc/patroni/patroni.yaml
COPY post-init.sh /scripts/post-init.sh
RUN chmod +x /scripts/post-init.sh

EXPOSE 5432 8008

ENTRYPOINT ["patroni", "/etc/patroni/patroni.yaml"]
