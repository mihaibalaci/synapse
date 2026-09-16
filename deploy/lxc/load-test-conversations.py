#!/usr/bin/env python3
"""Synapse load test for conversation grouping and ordered compaction.

Unlike load-test-4k.sh, which sends one two-message capture per session, this
driver simulates how clients actually behave: a conversation is pushed as several
small batches that share a conversationId, exactly as the SDK trackers do when
they flush every four messages.

That shape is what compaction needs in order to be exercised at all:

  level 1  several batches sharing a conversationId  -> conversation_summary
  level 2  single-batch conversations                -> summary
  level 3  separate conversations on the same topic  -> topic_summary

Each topic is therefore reused across several conversations, so level 3 has
groups to find, and a share of conversations are deliberately left single-batch
so level 2 still has standalone work.

Stdlib only. Usage:

    SYNAPSE_LOADTEST_PASSWORD=... ./load-test-conversations.py \
        --url http://172.16.10.45:3000 --conversations 300

    ./load-test-conversations.py --dry-run      # generate payloads, send nothing
"""

from __future__ import annotations

import argparse
import json
import os
import random
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed

MESSAGES_PER_BATCH = 4  # matches the SDK tracker default flush threshold

# ─── Topics ──────────────────────────────────────────────────────────────────
# Each topic is reused by several conversations. Wording varies per conversation
# while the substance stays the same, which is what topic-level consolidation is
# meant to detect: separate conversations reaching the same conclusions.

TOPICS = [
    {
        "key": "db-pooling",
        "subject": "database connection pooling in Go",
        "initial": "pgxpool with MaxConns=20, MinConns=3, MaxConnLifetime=30m",
        "revised": "MaxConns=40 after the p99 latency spike during the March migration",
        "constraint": "a pool must never be shared across goroutines unless it manages concurrency internally",
        "open": "whether read replicas get their own separate pool",
        "repository": "user-service",
        "language": "go",
    },
    {
        "key": "api-errors",
        "subject": "error handling in the API layer",
        "initial": "structured errors carrying an error code enum, HTTP status, and a user-safe message",
        "revised": "wrapping with fmt.Errorf and %w everywhere so the cause survives to the log",
        "constraint": "internal error text is logged with the request id but never returned to the caller",
        "open": "whether to expose a machine-readable error catalog to API consumers",
        "repository": "api-gateway",
        "language": "go",
    },
    {
        "key": "grpc-vs-rest",
        "subject": "internal service-to-service transport",
        "initial": "gRPC with protobuf internally, REST only at the edge",
        "revised": "REST kept for two legacy consumers that could not adopt gRPC in time",
        "constraint": "type safety and streaming matter more than human-readable payloads internally",
        "open": "whether the legacy REST shims can be retired next quarter",
        "repository": "payment-service",
        "language": "go",
    },
    {
        "key": "feature-flags",
        "subject": "feature flag rollout",
        "initial": "LaunchDarkly evaluated at the handler level with a local cache fallback",
        "revised": "a hard rule that flags are removed within two sprints, after stale flags caused an incident",
        "constraint": "flags are never evaluated deep inside business logic",
        "open": "who owns the quarterly audit of live flags",
        "repository": "frontend-web",
        "language": "typescript",
    },
    {
        "key": "graceful-shutdown",
        "subject": "graceful shutdown",
        "initial": "SIGTERM stops new work, in-flight requests drain within 10s",
        "revised": "a 30s drain window after the 10s cut truncated long ingestion jobs",
        "constraint": "database pools close only after the drain window has elapsed",
        "open": "whether the drain window should be per-service rather than global",
        "repository": "notification-service",
        "language": "go",
    },
    {
        "key": "k8s-provisioning",
        "subject": "provisioning new Kubernetes clusters",
        "initial": "Terraform modules building VPC, node groups, workload identity, and autoscaler",
        "revised": "spot node groups for non-critical workloads once cost review flagged the on-demand spend",
        "constraint": "state lives in S3 with DynamoDB locking, never locally",
        "open": "whether dev clusters should be ephemeral per developer",
        "repository": "infra-terraform",
        "language": "hcl",
    },
    {
        "key": "secrets",
        "subject": "secrets management in Kubernetes",
        "initial": "External Secrets Operator syncing from Vault into namespaced Secrets",
        "revised": "mounting secrets as files rather than environment variables to avoid /proc leaks",
        "constraint": "no secret is ever committed to git or placed in a ConfigMap",
        "open": "how to shorten the 90-day database credential rotation",
        "repository": "platform-helm",
        "language": "yaml",
    },
    {
        "key": "migrations",
        "subject": "database migrations",
        "initial": "forward-only migrations embedded in the binary behind an advisory lock",
        "revised": "checksum verification after an edited migration diverged between environments",
        "constraint": "columns are added nullable or defaulted; nothing is renamed or dropped in place",
        "open": "whether rollback should be anything other than restore from backup",
        "repository": "user-service",
        "language": "go",
    },
    {
        "key": "caching",
        "subject": "caching strategy",
        "initial": "Redis for shared state, in-process LRU for config with a 5 minute TTL",
        "revised": "singleflight protection after a cache stampede saturated the database",
        "constraint": "user-specific data is never cached without explicit invalidation",
        "open": "whether the LRU TTL should differ per config namespace",
        "repository": "api-gateway",
        "language": "go",
    },
    {
        "key": "observability",
        "subject": "observability",
        "initial": "Prometheus and Grafana for metrics, Loki for logs, Tempo for traces",
        "revised": "mandatory request_id propagation through context after an untraceable outage",
        "constraint": "every service exposes /metrics with request count, latency histogram, and error count",
        "open": "whether trace sampling should be raised above 10% in production",
        "repository": "platform-helm",
        "language": "yaml",
    },
    {
        "key": "deploy-pipeline",
        "subject": "the deployment pipeline",
        "initial": "GitHub Actions building images, ArgoCD syncing from updated Helm values",
        "revised": "canary steps at 10/50/100% with automatic rollback on an error-rate spike",
        "constraint": "images are pinned by git SHA; no latest tag reaches production",
        "open": "whether canary analysis should gate on latency as well as errors",
        "repository": "infra-terraform",
        "language": "hcl",
    },
    {
        "key": "backups",
        "subject": "the backup strategy",
        "initial": "PostgreSQL WAL archiving every 5 minutes plus a daily base backup",
        "revised": "quarterly restore drills after a backup proved unrestorable",
        "constraint": "retention is 30 days with cross-region replication for critical data",
        "open": "whether RPO can be brought under one hour without more storage cost",
        "repository": "infra-terraform",
        "language": "hcl",
    },
    {
        "key": "rate-limiting",
        "subject": "API rate limiting",
        "initial": "a token bucket per API key with per-tier limits held in Redis",
        "revised": "a sliding window after burst traffic slipped through the bucket refill",
        "constraint": "429 responses always carry a Retry-After header",
        "open": "whether enterprise tiers need per-endpoint limits",
        "repository": "api-gateway",
        "language": "go",
    },
    {
        "key": "auth",
        "subject": "user authentication",
        "initial": "OAuth2 and OIDC with 15 minute access tokens and refresh in HttpOnly cookies",
        "revised": "mandatory MFA for admin roles after a credential-stuffing attempt",
        "constraint": "sessions are revoked on password change",
        "open": "whether service accounts should use the same token lifetime",
        "repository": "auth-service",
        "language": "go",
    },
    {
        "key": "testing",
        "subject": "the testing strategy",
        "initial": "roughly 70% unit, 20% integration with containers, 10% end to end",
        "revised": "dropping mocks for code we own after they hid a real contract break",
        "constraint": "integration tests run against real PostgreSQL and Redis, not fakes",
        "open": "whether end-to-end tests should gate merges or only releases",
        "repository": "qa-automation",
        "language": "python",
    },
]

PREFIXES = ["", "Quick question: ", "Team discussion: ", "Following up: ", "Regarding "]
SUFFIXES = ["", " Any concerns?", " Should we revisit this?", " This matches the roadmap.", ""]

# Ingestion segments at roughly 800-1200 tokens per chunk, and level 2 only
# considers sessions holding at least three active chunks. Short synthetic
# batches never reach that, so standalone conversations carry long-form answers
# to produce enough chunks for level 2 to have anything to do.
DETAIL_SENTENCES = [
    "The rollout was staged behind a flag so the blast radius stayed small.",
    "Latency was measured at p50, p95, and p99 before and after the change.",
    "We compared two candidate approaches and rejected the first on operational cost.",
    "The runbook was updated with the exact commands an on-call engineer needs.",
    "Alert thresholds were tuned after the first week produced too much noise.",
    "A dashboard tracks the three signals that indicate the change is misbehaving.",
    "Capacity headroom was verified against projected growth for two quarters.",
    "The failure mode we care about is silent degradation rather than a hard outage.",
    "Rollback was rehearsed in staging and takes under five minutes.",
    "Ownership sits with the team that operates the service, not the one that wrote it.",
    "Cost impact was reviewed and stayed within the existing budget envelope.",
    "Security review covered the new network path and the credentials it uses.",
]


def long_form(topic: dict, rng: random.Random, target_chars: int = 5000) -> str:
    """Expand an answer with substantive detail until it reaches target_chars."""
    parts = [f"Full write-up on {topic['subject']}. Current decision: {topic['revised']}, "
             f"which superseded {topic['initial']}. Constraint: {topic['constraint']}. "
             f"Open item: {topic['open']}."]
    while sum(len(p) for p in parts) < target_chars:
        parts.append(rng.choice(DETAIL_SENTENCES))
    return " ".join(parts)


def build_messages(topic: dict, rng: random.Random, count: int,
                   detailed: bool = False) -> list[dict]:
    """Build a chronological conversation of `count` messages about one topic.

    The arc deliberately includes a decision that changes mid-conversation, so a
    consolidated summary has something to reconcile that no single batch shows.
    When detailed is set, assistant turns carry long-form content so the session
    segments into enough chunks to be eligible for level 2.
    """
    subject = topic["subject"]
    exchanges = [
        (f"{rng.choice(PREFIXES)}how should we handle {subject}?",
         f"We settled on {topic['initial']}.{rng.choice(SUFFIXES)}"),
        (f"What constraint should everyone know about {subject}?",
         f"Mainly that {topic['constraint']}."),
        (f"Did the {subject} decision hold up in production?",
         f"Not entirely. We changed course: {topic['revised']}."),
        (f"So what is the current position on {subject}?",
         f"Current decision is {topic['revised']}, superseding the earlier {topic['initial']}."),
        (f"Anything still unresolved about {subject}?",
         f"Yes: {topic['open']}. Everything else is stable."),
        (f"Who should own {subject} going forward?",
         f"The owning team keeps it, and the constraint stands: {topic['constraint']}."),
    ]

    messages: list[dict] = []
    for question, answer in exchanges:
        if len(messages) >= count:
            break
        if detailed:
            # The segmenter flushes on message boundaries once a chunk passes its
            # token budget, so chunk count tracks the number of large messages.
            # Every message must therefore be substantial for the session to
            # reach the three chunks level 2 requires.
            question = f"{question} Context I gathered: {long_form(topic, rng, 4500)}"
            answer = f"{answer} {long_form(topic, rng, 5000)}"
        messages.append({"role": "user", "content": question})
        if len(messages) < count:
            messages.append({"role": "assistant", "content": answer})
    return messages[:count]


def plan_conversations(total: int, standalone_ratio: float, max_batches: int,
                       seed: int, topic_count: int) -> list[dict]:
    """Plan the run: which topic each conversation covers and how many batches.

    Topics are assigned in contiguous blocks rather than round-robin, so that
    conversations about the same subject are captured close together in time.
    Topic consolidation walks candidates oldest-first, so interleaved topics
    would leave every early group with only one conversation and nothing to
    merge.
    """
    rng = random.Random(seed)
    topics = TOPICS[:max(1, min(topic_count, len(TOPICS)))]
    per_topic = max(1, -(-total // len(topics)))  # ceil

    plan = []
    for i in range(total):
        topic = topics[min(i // per_topic, len(topics) - 1)]
        standalone = rng.random() < standalone_ratio
        batches = 1 if standalone else rng.randint(2, max_batches)
        messages = build_messages(topic, rng, batches * MESSAGES_PER_BATCH,
                                  detailed=standalone)
        plan.append({
            "conversation_id": str(uuid.uuid4()),
            "topic": topic,
            "batches": [messages[j:j + MESSAGES_PER_BATCH]
                        for j in range(0, len(messages), MESSAGES_PER_BATCH)],
            "standalone": standalone,
        })
    return plan


# ─── HTTP ────────────────────────────────────────────────────────────────────

class Client:
    def __init__(self, url: str, timeout: int = 30):
        self.url = url.rstrip("/")
        self.timeout = timeout
        self.token = ""

    def _post(self, path: str, body: dict) -> tuple[int, dict, float]:
        data = json.dumps(body).encode()
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        req = urllib.request.Request(self.url + path, data=data, headers=headers, method="POST")
        started = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                elapsed = time.perf_counter() - started
                return resp.status, json.loads(resp.read() or b"{}"), elapsed
        except urllib.error.HTTPError as e:
            return e.code, {}, time.perf_counter() - started
        except Exception:
            return 0, {}, time.perf_counter() - started

    def get(self, path: str) -> dict:
        req = urllib.request.Request(self.url + path, method="GET")
        if self.token:
            req.add_header("Authorization", f"Bearer {self.token}")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read() or b"{}")
        except Exception:
            return {}

    def login(self, email: str, password: str, org: str) -> None:
        status, body, _ = self._post("/api/v1/auth/login",
                                     {"email": email, "password": password, "organizationId": org})
        if status != 200 or not body.get("accessToken"):
            raise SystemExit(f"authentication failed (HTTP {status})")
        self.token = body["accessToken"]

    def capture(self, messages: list[dict], conversation_id: str, topic: dict):
        return self._post("/api/v1/capture/passive", {
            "messages": messages,
            "source": "load-test-conversations",
            "repository": topic["repository"],
            "language": topic["language"],
            "conversationId": conversation_id,
        })


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, int(round(pct / 100 * (len(ordered) - 1))))
    return ordered[idx]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default=os.environ.get("SYNAPSE_URL", "http://172.16.10.45:3000"))
    ap.add_argument("--conversations", type=int, default=300)
    ap.add_argument("--concurrency", type=int, default=20,
                    help="conversations in flight; batches within one are sequential")
    ap.add_argument("--max-batches", type=int, default=3)
    ap.add_argument("--standalone-ratio", type=float, default=0.3,
                    help="share of conversations sent as a single batch (level 2 input)")
    ap.add_argument("--topics", type=int, default=len(TOPICS),
                    help="how many distinct topics to draw from")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--dry-run", action="store_true", help="generate payloads without sending")
    ap.add_argument("--drain-timeout", type=int, default=900,
                    help="seconds to wait for the ingestion queue to drain")
    args = ap.parse_args()

    plan = plan_conversations(args.conversations, args.standalone_ratio,
                              args.max_batches, args.seed, args.topics)
    total_batches = sum(len(c["batches"]) for c in plan)
    total_messages = sum(len(b) for c in plan for b in c["batches"])
    total_chars = sum(len(m["content"]) for c in plan for b in c["batches"] for m in b)
    multi = sum(1 for c in plan if not c["standalone"])
    topics_used = len({c["topic"]["key"] for c in plan})

    print("=" * 63)
    print("  Synapse Load Test — conversation grouping")
    print(f"  Target: {args.url}")
    print(f"  Conversations: {len(plan)} ({multi} multi-batch, {len(plan) - multi} standalone)")
    print(f"  Batches: {total_batches} | Messages: {total_messages} "
          f"| {MESSAGES_PER_BATCH} per batch | ~{total_chars // 1000}k chars")
    print(f"  Topics: {topics_used} (each reused by ~{len(plan) // max(1, topics_used)} "
          f"conversations, in contiguous blocks)")
    print(f"  Concurrency: {args.concurrency}")
    print("=" * 63)

    if args.dry_run:
        sample = plan[0]
        print("\n[dry run] first conversation:")
        print(f"  conversationId={sample['conversation_id']} batches={len(sample['batches'])}")
        for i, batch in enumerate(sample["batches"], 1):
            print(f"  --- batch {i} ---")
            for m in batch:
                print(f"    {m['role']}: {m['content'][:90]}")
        print("\n[dry run] nothing was sent")
        return 0

    password = os.environ.get("SYNAPSE_LOADTEST_PASSWORD")
    if not password:
        print("SYNAPSE_LOADTEST_PASSWORD is not set", file=sys.stderr)
        return 2

    client = Client(args.url)
    print("\n[1/4] Authenticating...")
    client.login(os.environ.get("SYNAPSE_LOADTEST_EMAIL", "admin@synapse.local"),
                 password,
                 os.environ.get("SYNAPSE_LOADTEST_ORG", "default"))
    print("    token acquired")

    ready = client.get("/health/ready")
    checks = ready.get("checks", {})
    print(f"    dependencies: {', '.join(f'{k}={v}' for k, v in sorted(checks.items())) or 'unknown'}")

    before = client.get("/api/v1/stats").get("counts", {})
    print(f"    sessions before: {before.get('sessions', '?')}")

    latencies: list[float] = []
    statuses: dict[int, int] = {}
    echoed_conversation_ids = 0
    lock = threading.Lock()

    def run_conversation(conv: dict) -> None:
        nonlocal echoed_conversation_ids
        # Batches of one conversation go in order, mirroring a live client.
        for batch in conv["batches"]:
            status, body, elapsed = client.capture(batch, conv["conversation_id"], conv["topic"])
            with lock:
                latencies.append(elapsed)
                statuses[status] = statuses.get(status, 0) + 1
                if body.get("conversationId"):
                    echoed_conversation_ids += 1

    print(f"\n[2/4] Sending {total_batches} batches across {len(plan)} conversations...")
    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = [pool.submit(run_conversation, c) for c in plan]
        for done in as_completed(futures):
            done.result()
    duration = time.perf_counter() - started

    accepted = statuses.get(202, 0)
    print(f"    duration: {duration:.1f}s")
    print(f"    throughput: {total_batches / duration:.1f} captures/sec "
          f"({total_messages / duration:.1f} messages/sec)")
    print(f"    accepted (202): {accepted}/{total_batches}")
    for status, count in sorted(statuses.items()):
        if status != 202:
            label = "connection error" if status == 0 else f"HTTP {status}"
            print(f"    {label}: {count}")
    if latencies:
        print(f"    latency p50 {percentile(latencies, 50) * 1000:.0f}ms"
              f" p95 {percentile(latencies, 95) * 1000:.0f}ms"
              f" p99 {percentile(latencies, 99) * 1000:.0f}ms"
              f" max {max(latencies) * 1000:.0f}ms"
              f" mean {statistics.mean(latencies) * 1000:.0f}ms")
    else:
        print("    no latencies recorded")

    # The new build echoes conversationId; an older build omits it. This is the
    # cheapest way to confirm the deployment under test actually records grouping.
    print(f"\n[3/4] Conversation grouping accepted by server: "
          f"{echoed_conversation_ids}/{total_batches} responses echoed a conversationId")
    if echoed_conversation_ids == 0:
        print("    WARNING: no conversationId echoed — the target is probably an older build,")
        print("    so these captures were stored without conversation grouping.")

    print(f"\n[4/4] Waiting for ingestion to drain (timeout {args.drain_timeout}s)...")
    deadline = time.time() + args.drain_timeout
    last = {}
    while time.time() < deadline:
        stats = client.get("/api/v1/stats")
        counts, processing = stats.get("counts", {}), stats.get("processing", {})
        queues = stats.get("queues", {})
        last = {"sessions": counts.get("sessions"), "chunks": counts.get("chunks"),
                "facts": counts.get("facts"), "queue": queues.get("total"),
                "active": processing.get("activeSessions"), "failed": processing.get("failed")}
        if (queues.get("total") in (0, None)) and (processing.get("activeSessions") in (0, None)):
            break
        time.sleep(5)
    else:
        print("    drain timeout reached; reporting last observed state")

    print(f"    sessions={last.get('sessions')} chunks={last.get('chunks')} "
          f"facts={last.get('facts')} queue={last.get('queue')} failed={last.get('failed')}")
    delta = (last.get("sessions") or 0) - (before.get("sessions") or 0)
    print(f"    sessions added: {delta} (expected {total_batches})")

    print("\n" + "=" * 63)
    print(f"  Done. {accepted}/{total_batches} accepted in {duration:.1f}s")
    print("  Next: run compaction to exercise the three levels, e.g.")
    print("    COMPACTION_MIN_AGE_DAYS=0 COMPACTION_TOPIC_MIN_AGE_DAYS=0 \\")
    print("      COMPACTION_MAX_PER_RUN=10 COMPACTION_MAX_CLUSTERS=2 synapse compact")
    print("=" * 63)
    return 0 if accepted == total_batches else 1


if __name__ == "__main__":
    sys.exit(main())
