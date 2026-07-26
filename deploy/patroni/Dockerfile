FROM postgres:16.9-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-psycopg2 postgresql-16-pgvector pgbackrest \
    && pip3 install --break-system-packages --no-cache-dir 'patroni[kubernetes]==4.0.6' \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY patroni.yaml /etc/patroni/patroni.yaml
COPY pgbackrest.conf /etc/pgbackrest/pgbackrest.conf
COPY post-init.sh /scripts/post-init.sh
RUN chmod 0755 /scripts/post-init.sh \
    && install -d -o postgres -g postgres /var/spool/pgbackrest /var/log/pgbackrest

EXPOSE 5432 8008
HEALTHCHECK --interval=10s --timeout=5s --retries=6 CMD pg_isready -U postgres -d postgres || exit 1
USER postgres
ENTRYPOINT ["patroni", "/etc/patroni/patroni.yaml"]
