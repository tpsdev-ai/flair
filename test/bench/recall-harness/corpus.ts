/**
 * corpus.ts — synthetic corpus + ground-truth queries for the isolated
 * recall-eval harness (test/bench/recall-harness/run.ts).
 *
 * WHY THIS CORPUS EXISTS (vs. the 4-cluster one in ops/tools/agent-fabric/recall-bench.mjs):
 * recall-bench's CORPUS is 4 maximally-distant topic clusters (distributed
 * consensus / coffee / index funds / houseplants), 4 memories each, one
 * unambiguous correct answer per query. That's a "flattering upper bound":
 * every distractor is topically miles away, so almost any embedding gets
 * p@3 = 1.00 — it CANNOT discriminate between a scoring/retrieval config that
 * genuinely helps and one that hurts, because there's no headroom to lose.
 * (See recall-bench.mjs's own header, "KNOWN BIASES".)
 *
 * This corpus is deliberately harder along three axes a real agent memory
 * corpus actually has:
 *
 *   1. NEAR-DUPLICATE / ADJACENT DENSITY — most clusters below hold several
 *      records about the SAME narrow topic from different angles (e.g. four
 *      separate facts about Raft, or three JWT/token-lifecycle facts that all
 *      share vocabulary). A query's correct answer often has to beat a close
 *      paraphrase or an adjacent-but-wrong fact in the SAME cluster, not just
 *      four unrelated topics.
 *   2. CROSS-CLUSTER "TRAP" CLUSTERS — a few clusters exist ONLY to share
 *      surface vocabulary with a real-target cluster while answering a
 *      different domain: ENG-TEAM-PROCESS shares "consensus"/"leader" with
 *      CONSENSUS; TEA shares brewing vocabulary with COFFEE; GARDEN shares
 *      "branch"/plant-care vocabulary with GIT and PLANT; DB-INDEXING shares
 *      the word "index" with FINANCE's index funds. These test whether a
 *      config (especially BM25/hybrid) confuses lexical overlap for
 *      relevance.
 *   3. VARIED DURABILITY + createdAt (recency) — records are spread across
 *      all four durability levels (permanent/persistent/standard/ephemeral)
 *      and ages from ~2 days to ~110 days old. This is what lets the harness
 *      actually MEASURE compositeScore's durability-weight × recency-decay
 *      effect (resources/scoring.ts) instead of assuming it.
 *
 * THE "STRESS PAIRS" — the deliberate composite-vs-raw discriminator:
 * Seven records are marked STRESS CORRECT below; each has a same-cluster
 * "STRESS DISTRACTOR" sibling that is semantically adjacent (same topic,
 * different specific fact) but assigned `permanent` durability and a
 * ~2-3-day createdAt, while the correct answer is `standard`/`persistent`
 * and 50-90 days old. Under scoring="raw" (semantic + keyword only, no
 * durability/recency weighting — see resources/SemanticSearch.ts) the
 * correct, better-matching record should win. Under scoring="composite",
 * compositeScore's dWeight × rFactor multiplier (0.4-1.0 × ~0-1, UNCONDITIONAL,
 * no relevance floor — resources/scoring.ts) can be large enough to invert
 * that ranking in favor of the fresher/more-durable-but-wrong sibling. This
 * is the exact mechanism flair#623 (fixed in commit 624299c, 2026-07-08:
 * "default SemanticSearch scoring to raw, not composite") found on the LIVE
 * corpus — this harness reproduces it in isolation, on a purpose-built
 * corpus, without ever touching production. See run.ts's REPORT for the
 * measured composite-vs-raw delta this corpus produces.
 *
 * GROUND TRUTH — how relevance was assigned: every query below was written
 * by hand against ONE specific corpus record, then checked that no OTHER
 * record answers the query's literal question as directly. Four query
 * "kinds" are tagged (see QueryKind) so a reader can see WHY each pair is in
 * the set instead of taking p@3 on faith:
 *   stress — targets one of the 7 durability/recency stress pairs above.
 *   trap   — targets a record in a "real" cluster whose query wording shares
 *            strong surface vocabulary with a same-corpus TRAP cluster.
 *   hard   — targets one of two-or-more genuine near-duplicate records in the
 *            SAME cluster; the correct id is the one that answers the
 *            query's specific question, but a close sibling is a plausible
 *            rank-2/3 confusion (this is what keeps p@3 from trivially
 *            capping at 1.0 the way recall-bench's does).
 *   clean  — an unambiguous, single-best-answer query, kept as a sanity
 *            floor so the corpus isn't ADVERSARIAL everywhere (a corpus that
 *            is 100% stress cases would itself be an unrepresentative
 *            upper-bound-on-difficulty, same failure mode as recall-bench's
 *            4-cluster corpus but inverted).
 *
 * ageDays is relative to seed time (computed fresh by run.ts on every seed),
 * not an absolute date — so the corpus's relative recency shape is identical
 * on every run regardless of when it's run.
 */

export type Durability = "permanent" | "persistent" | "standard" | "ephemeral";

export interface CorpusRecord {
  /** Unique marker, e.g. "CONSENSUS::1". Also used to derive the record's id. */
  marker: string;
  cluster: string;
  text: string;
  durability: Durability;
  /** Age in days at seed time (createdAt = now - ageDays). */
  ageDays: number;
  /** Free-form note on why this record's durability/age was chosen. */
  note?: string;
}

export type QueryKind = "stress" | "trap" | "hard" | "clean";

export interface GroundTruthQuery {
  q: string;
  expectMarker: string;
  kind: QueryKind;
  /** What this query is specifically testing, and against which distractor. */
  note: string;
}

// ─── Corpus: 12 clusters, 87 records ────────────────────────────────────────
export const CORPUS: CorpusRecord[] = [
  // ── CONSENSUS: distributed-systems consensus (8) ──────────────────────────
  { marker: "CONSENSUS::1", cluster: "CONSENSUS", durability: "standard", ageDays: 75,
    text: "Raft elects a single leader per term: each follower grants its vote to the first candidate whose log is at least as up to date as its own, and a candidate must collect votes from a majority of the cluster to become leader.",
    note: "STRESS CORRECT (vs CONSENSUS::8): older + standard durability." },
  { marker: "CONSENSUS::2", cluster: "CONSENSUS", durability: "standard", ageDays: 40,
    text: "A Raft log entry counts as committed only once a majority of nodes have replicated it; the leader then applies it to its own state machine and includes the new commit index in the next heartbeat to followers." },
  { marker: "CONSENSUS::3", cluster: "CONSENSUS", durability: "persistent", ageDays: 110,
    text: "Paxos splits the work across three roles — proposer, acceptor, and learner — and reaches agreement in two rounds: a prepare phase that carries a proposal number, followed by an accept phase that carries the value tied to that number." },
  { marker: "CONSENSUS::4", cluster: "CONSENSUS", durability: "persistent", ageDays: 95,
    text: "When a network partition splits a consensus cluster so neither side can reach a majority, the cluster halts new writes on both sides rather than risk two histories diverging — availability is sacrificed to preserve a single truth." },
  { marker: "CONSENSUS::5", cluster: "CONSENSUS", durability: "standard", ageDays: 30,
    text: "In Raft, a candidate starts an election after its heartbeat timeout expires, bumps the term number, and requests votes from every peer; if it wins a majority before another leader emerges it starts sending heartbeats of its own.",
    note: "Near-dup of CONSENSUS::1 (election-timeout mechanics vs the vote-granting rule)." },
  { marker: "CONSENSUS::6", cluster: "CONSENSUS", durability: "standard", ageDays: 60,
    text: "ZooKeeper's Zab protocol totally orders writes through a single elected leader much like Raft, but recovery after a leader crash replays a synchronization phase that reconciles each follower's history before normal broadcast resumes." },
  { marker: "CONSENSUS::7", cluster: "CONSENSUS", durability: "standard", ageDays: 25,
    text: "A quorum read or write only needs to touch a majority of replicas, not all of them, so a consensus system stays available even when a minority of nodes are slow or unreachable, at the cost of an extra round trip to reconcile stale replicas.",
    note: "Near-dup facet of CONSENSUS::4 (quorum read/write path vs partition-halt)." },
  { marker: "CONSENSUS::8", cluster: "CONSENSUS", durability: "permanent", ageDays: 2,
    text: "Once elected, a Raft leader proves it is still alive by sending periodic heartbeats before its lease expires; if followers stop hearing them in time they assume the leader is gone and start a new election.",
    note: "STRESS DISTRACTOR for CONSENSUS::1: fresh + permanent, adjacent topic (staying leader, not becoming leader)." },

  // ── ENG: engineering team process (6) — adjacent-vocab trap for CONSENSUS ─
  { marker: "ENG::1", cluster: "ENG", durability: "standard", ageDays: 20,
    text: "Daily standups work best kept to fifteen minutes and three questions per person: what you did, what you're doing next, and anything blocking you — anything longer becomes a status meeting, not a sync." },
  { marker: "ENG::2", cluster: "ENG", durability: "standard", ageDays: 45,
    text: "When an engineering team can't reach consensus on a design in one sitting, write the disagreement down as an RFC with the options and tradeoffs spelled out, then time-box the discussion instead of letting the thread run forever." },
  { marker: "ENG::3", cluster: "ENG", durability: "persistent", ageDays: 85,
    text: "A tech lead is not automatically the most senior engineer; the role is about unblocking the team, owning technical direction, and making the tie-breaking call when consensus stalls — not writing the most code." },
  { marker: "ENG::4", cluster: "ENG", durability: "standard", ageDays: 10,
    text: "Sprint retros work better when you pick one or two concrete changes to try next sprint instead of relitigating every complaint — a long list of action items is really a list of things that won't get done." },
  { marker: "ENG::5", cluster: "ENG", durability: "ephemeral", ageDays: 4,
    text: "On-call rotations should rotate the pager, not the accountability — whoever owns the service should still triage the postmortem even if a different engineer was holding the pager when it paged." },
  { marker: "ENG::6", cluster: "ENG", durability: "standard", ageDays: 33,
    text: "Reaching team agreement on a contentious technical choice usually goes faster with a short doc and an explicit decision deadline than with an open-ended meeting where the loudest voice tends to win by default." },

  // ── COFFEE: brewing methods (8) ──────────────────────────────────────────
  { marker: "COFFEE::1", cluster: "COFFEE", durability: "persistent", ageDays: 80,
    text: "A pour-over drips hot water in slow concentric circles over a paper-filtered bed of grounds, giving a clean, bright cup with the fines held back by the filter.",
    note: "STRESS CORRECT (vs COFFEE::6): older + persistent durability." },
  { marker: "COFFEE::2", cluster: "COFFEE", durability: "standard", ageDays: 45,
    text: "A French press steeps coarse grounds in water for about four minutes, then a metal mesh plunger separates the liquid, leaving a fuller, heavier body in the cup." },
  { marker: "COFFEE::3", cluster: "COFFEE", durability: "standard", ageDays: 20,
    text: "An espresso shot forces near-boiling water through finely tamped grounds at roughly nine bars of pressure, pulling a concentrated ounce topped with golden crema." },
  { marker: "COFFEE::4", cluster: "COFFEE", durability: "standard", ageDays: 35,
    text: "Cold brew soaks coarse grounds in room-temperature or chilled water for twelve to twenty-four hours, yielding a smooth, low-acidity concentrate you dilute before serving." },
  { marker: "COFFEE::5", cluster: "COFFEE", durability: "standard", ageDays: 15,
    text: "A moka pot forces steam pressure up through grounds and into the upper chamber, producing a strong, espresso-adjacent cup without needing an actual espresso machine." },
  { marker: "COFFEE::6", cluster: "COFFEE", durability: "permanent", ageDays: 2,
    text: "An AeroPress presses hot water through fine grounds and a small paper filter in under a minute, splitting the difference between a pour-over's clarity and an espresso's short brew time.",
    note: "STRESS DISTRACTOR for COFFEE::1: fresh + permanent, also paper-filtered (plausible confusion)." },
  { marker: "COFFEE::7", cluster: "COFFEE", durability: "standard", ageDays: 50,
    text: "Letting a pour-over 'bloom' first — a short pre-soak that lets trapped CO2 escape before the main pour — keeps the extraction even instead of channeling water around dry pockets of grounds.",
    note: "Near-dup facet of COFFEE::1 (bloom technique vs basic method)." },
  { marker: "COFFEE::8", cluster: "COFFEE", durability: "standard", ageDays: 28,
    text: "Cold brew concentrate keeps well refrigerated for up to two weeks because the low-temperature steep extracts far less of the acid and oil that make hot-brewed coffee turn stale and bitter quickly.",
    note: "Near-dup facet of COFFEE::4 (shelf life vs method)." },

  // ── TEA: brewing methods (5) — adjacent-domain trap for COFFEE ───────────
  { marker: "TEA::1", cluster: "TEA", durability: "standard", ageDays: 18,
    text: "Green tea turns bitter and grassy if steeped in boiling water — aim for around 175°F and two minutes, not the near-boil and five minutes that black tea wants." },
  { marker: "TEA::2", cluster: "TEA", durability: "standard", ageDays: 40,
    text: "Black tea can take a full rolling boil and three to five minutes of steeping without turning harsh, which is why it stands up to milk better than green or white tea." },
  { marker: "TEA::3", cluster: "TEA", durability: "standard", ageDays: 60,
    text: "Oolong sits between green and black in oxidation, and a good oolong can be steeped multiple short infusions in a row, each one drawing out a slightly different flavor note." },
  { marker: "TEA::4", cluster: "TEA", durability: "persistent", ageDays: 75,
    text: "Matcha isn't steeped at all — the whole powdered leaf is whisked directly into hot water, which is why its caffeine and antioxidant content per cup runs higher than steeped tea." },
  { marker: "TEA::5", cluster: "TEA", durability: "ephemeral", ageDays: 6,
    text: "Iced tea gets cloudy when hot-brewed tea is poured directly over ice because the rapid cooling precipitates tannins; cold-brewing the tea overnight instead avoids the cloudiness entirely." },

  // ── FIN: personal finance / investing (8) ────────────────────────────────
  { marker: "FIN::1", cluster: "FIN", durability: "persistent", ageDays: 70,
    text: "A low-cost broad-market index fund tracks the whole market instead of picking stocks, and its tiny expense ratio compounds into a large advantage over decades.",
    note: "STRESS CORRECT (vs FIN::4): older + persistent durability." },
  { marker: "FIN::2", cluster: "FIN", durability: "standard", ageDays: 40,
    text: "Dollar-cost averaging means investing a fixed amount on a regular schedule regardless of price, smoothing out the cost of entry and removing the urge to time the market." },
  { marker: "FIN::3", cluster: "FIN", durability: "standard", ageDays: 55,
    text: "A tax-advantaged retirement account lets contributions grow without yearly taxes on gains; a Roth variant is funded with after-tax money so qualified withdrawals come out tax-free." },
  { marker: "FIN::4", cluster: "FIN", durability: "permanent", ageDays: 2,
    text: "Rebalancing periodically sells whatever asset class has grown beyond its target weight and buys the laggards, keeping your portfolio risk near the allocation you originally chose.",
    note: "STRESS DISTRACTOR for FIN::1: fresh + permanent, same cluster, different specific fact." },
  { marker: "FIN::5", cluster: "FIN", durability: "standard", ageDays: 25,
    text: "An emergency fund of three to six months of expenses sitting in something boring and liquid — not invested — is what keeps a market downturn from forcing you to sell stocks at the worst possible time." },
  { marker: "FIN::6", cluster: "FIN", durability: "standard", ageDays: 60,
    text: "A total-market index fund and an S&P 500 index fund overlap heavily, but the total-market version also owns the small- and mid-cap names the S&P 500 excludes by definition.",
    note: "Near-dup facet of FIN::1 (index-fund variants)." },
  { marker: "FIN::7", cluster: "FIN", durability: "standard", ageDays: 18,
    text: "An HSA is the rare triple-tax-advantaged account — contributions are pre-tax, growth is untaxed, and withdrawals for qualified medical expenses are never taxed either, which is why it's worth maxing before a Roth in many cases." },
  { marker: "FIN::8", cluster: "FIN", durability: "standard", ageDays: 32,
    text: "Automating a fixed monthly transfer into a broad index fund the same day your paycheck lands removes the decision point entirely — the money is invested before you've had a chance to talk yourself out of it.",
    note: "Near-dup facet of FIN::2 (automating DCA)." },

  // ── DBIDX: database indexing (8) — lexical "index" trap for FIN ─────────
  { marker: "DBIDX::1", cluster: "DBIDX", durability: "standard", ageDays: 50,
    text: "A B-tree index keeps keys sorted across a balanced tree so a database can find a row, or the start of a range, in logarithmic time instead of scanning every row." },
  { marker: "DBIDX::2", cluster: "DBIDX", durability: "standard", ageDays: 35,
    text: "A hash index maps a key straight to a bucket via a hash function, which makes an exact-match lookup very fast but can't help at all with a range query — the tree ordering that a B-tree has just isn't there." },
  { marker: "DBIDX::3", cluster: "DBIDX", durability: "standard", ageDays: 20,
    text: "A covering index includes every column a query needs directly in the index itself, so the database never has to jump back to the base table row — a much faster path than a normal index-then-lookup." },
  { marker: "DBIDX::4", cluster: "DBIDX", durability: "standard", ageDays: 42,
    text: "A partial index only covers rows matching a filter condition, which keeps it far smaller and cheaper to maintain than indexing the whole table when most queries only ever care about one subset of rows." },
  { marker: "DBIDX::5", cluster: "DBIDX", durability: "persistent", ageDays: 65,
    text: "A composite index over several columns only helps a query that filters on a left-to-right prefix of those columns — an index on (a, b, c) speeds up a query on a or (a, b), but not a query on b alone." },
  { marker: "DBIDX::6", cluster: "DBIDX", durability: "standard", ageDays: 15,
    text: "Every index you add speeds up reads but slows down every write, because the database has to keep that extra structure updated in lockstep with the table — indexing is a read/write tradeoff, not a free win." },
  { marker: "DBIDX::7", cluster: "DBIDX", durability: "standard", ageDays: 28,
    text: "An index-only scan answers a query straight from the index's own pages without ever touching the table, which is only possible when every selected column is already present in that index.",
    note: "Near-dup facet of DBIDX::3 (covering index vs the scan it enables)." },
  { marker: "DBIDX::8", cluster: "DBIDX", durability: "standard", ageDays: 8,
    text: "A B-tree index degrades over time as rows are deleted and inserted unevenly across the tree, leaving half-empty pages — periodic reindexing rebuilds it back to a dense, balanced structure." },

  // ── PLANT: houseplant care (9) ────────────────────────────────────────────
  { marker: "PLANT::1", cluster: "PLANT", durability: "persistent", ageDays: 65,
    text: "A snake plant tolerates low light and infrequent watering; let the soil dry out completely between waterings or its thick rhizomes will rot.",
    note: "STRESS CORRECT (vs PLANT::3): older + persistent durability." },
  { marker: "PLANT::2", cluster: "PLANT", durability: "standard", ageDays: 38,
    text: "A fiddle-leaf fig wants bright indirect light and hates being moved or sitting in soggy roots, so drainage and a consistent spot matter more than frequent watering." },
  { marker: "PLANT::3", cluster: "PLANT", durability: "permanent", ageDays: 2,
    text: "A pothos vine grows fast in almost any light and roots easily from cuttings placed in a glass of water, making it the classic beginner trailing plant.",
    note: "STRESS DISTRACTOR for PLANT::1: fresh + permanent, also 'easy/low-maintenance houseplant'." },
  { marker: "PLANT::4", cluster: "PLANT", durability: "standard", ageDays: 22,
    text: "Overwatering kills more houseplants than drought; yellowing lower leaves and gnats hovering over the soil usually mean the roots are staying wet too long." },
  { marker: "PLANT::5", cluster: "PLANT", durability: "standard", ageDays: 30,
    text: "Underwatering shows up as crispy brown leaf edges and a pot that feels suspiciously light when you lift it, quite different from overwatering's soft yellow leaves and heavy, waterlogged soil.",
    note: "Near-dup/contrast of PLANT::4 (underwatering vs overwatering signs)." },
  { marker: "PLANT::6", cluster: "PLANT", durability: "standard", ageDays: 48,
    text: "Most houseplants actually want more humidity than a heated indoor room provides in winter — a pebble tray or a small humidifier does more for a fussy tropical plant than adjusting the watering schedule." },
  { marker: "PLANT::7", cluster: "PLANT", durability: "standard", ageDays: 55,
    text: "Feeding houseplants a diluted liquid fertilizer roughly monthly during spring and summer growth is plenty — feeding through winter dormancy just builds up salts in soil that isn't actively using the nutrients." },
  { marker: "PLANT::8", cluster: "PLANT", durability: "standard", ageDays: 12,
    text: "Roots circling tightly at the bottom of the pot, or growing out of the drainage holes, mean a plant is rootbound and overdue for a repot into a container one size up." },
  { marker: "PLANT::9", cluster: "PLANT", durability: "ephemeral", ageDays: 5,
    text: "Gnats hovering just above the soil surface are almost always a sign the top inch is staying wet too long between waterings, not a sign of the plant itself being unhealthy.",
    note: "Near-dup facet of PLANT::4 (the gnat detail specifically, vs the general overwatering picture)." },

  // ── GARDEN: outdoor gardening (5) — adjacent-domain trap for PLANT + GIT ─
  { marker: "GARDEN::1", cluster: "GARDEN", durability: "standard", ageDays: 25,
    text: "Pruning the suckers off a tomato plant — the small shoots that grow in the joint between the main stem and a branch — redirects the plant's energy into fewer, larger fruit instead of a tangle of foliage.",
    note: "Shares 'branch' vocabulary with the GIT cluster — trap target for a git query." },
  { marker: "GARDEN::2", cluster: "GARDEN", durability: "standard", ageDays: 50,
    text: "A good compost pile wants roughly equal parts 'browns' like dry leaves or cardboard and 'greens' like vegetable scraps or grass clippings, turned every week or two so it doesn't go anaerobic and start to smell." },
  { marker: "GARDEN::3", cluster: "GARDEN", durability: "standard", ageDays: 15,
    text: "A few inches of mulch over garden soil suppresses weeds, holds moisture so you water less often, and breaks down slowly to add organic matter — straw and wood chips both work, just don't pile it against stems." },
  { marker: "GARDEN::4", cluster: "GARDEN", durability: "ephemeral", ageDays: 5,
    text: "Outdoor beds generally want a deep, infrequent soak rather than a light daily sprinkle, because shallow watering trains roots to stay near the surface where they dry out fastest." },
  { marker: "GARDEN::5", cluster: "GARDEN", durability: "standard", ageDays: 35,
    text: "Aphids cluster on new growth and the undersides of leaves; a strong blast of water or a diluted insecticidal soap knocks most of them off without reaching for a broad-spectrum pesticide." },

  // ── AUTH: API authentication (8) ──────────────────────────────────────────
  { marker: "AUTH::1", cluster: "AUTH", durability: "standard", ageDays: 55,
    text: "OAuth2's authorization code flow redirects the user to the provider to log in and approve access, then exchanges a short-lived code for tokens server-side, so the access token never has to pass through the browser.",
    note: "STRESS CORRECT (vs AUTH::3): older + standard durability." },
  { marker: "AUTH::2", cluster: "AUTH", durability: "standard", ageDays: 30,
    text: "A static API key is simple to issue and simple to check, but it carries no built-in expiry or scope narrowing — anyone who has it can do everything it's allowed to do until you revoke it entirely." },
  { marker: "AUTH::3", cluster: "AUTH", durability: "permanent", ageDays: 3,
    text: "A JWT bundles claims like the subject, issuer, and expiry into a signed payload the recipient can verify without a database round trip, but a leaked one is valid until it expires — there's no revoke button.",
    note: "STRESS DISTRACTOR for AUTH::1: fresh + permanent, adjacent auth topic." },
  { marker: "AUTH::4", cluster: "AUTH", durability: "standard", ageDays: 45,
    text: "Mutual TLS has both sides present a certificate during the handshake, not just the server, so the connection itself proves both parties' identity before a single request is sent." },
  { marker: "AUTH::5", cluster: "AUTH", durability: "standard", ageDays: 20,
    text: "HMAC request signing hashes the request body and a shared secret together into a signature header, so a receiver can confirm the request wasn't tampered with in transit without ever sending the secret itself." },
  { marker: "AUTH::6", cluster: "AUTH", durability: "standard", ageDays: 15,
    text: "A refresh token lets a client mint a new short-lived access token without forcing the user to log in again, and rotating the refresh token on each use limits the damage if one ever leaks.",
    note: "Near-dup/adjacent facet of AUTH::3 (token lifecycle)." },
  { marker: "AUTH::7", cluster: "AUTH", durability: "standard", ageDays: 8,
    text: "Storing an API key as a hash instead of the plaintext value means a database leak doesn't hand out working keys — the check works the same way a password hash check does, comparing hashes not the raw secret.",
    note: "Near-dup facet of AUTH::2." },
  { marker: "AUTH::8", cluster: "AUTH", durability: "standard", ageDays: 25,
    text: "A JWT's expiry claim only limits how long it's valid for — it says nothing about whether the token has been revoked early, which is why short expiries plus refresh tokens matter more than the signature algorithm chosen.",
    note: "Near-dup facet of AUTH::3/AUTH::6 (revocation vs expiry)." },

  // ── RATE: API rate limiting (6) — adjacent-domain trap for AUTH ─────────
  { marker: "RATE::1", cluster: "RATE", durability: "standard", ageDays: 20,
    text: "A token bucket refills at a fixed rate and lets a request through as long as there's a token in the bucket, which allows short bursts above the average rate as long as the bucket has tokens saved up." },
  { marker: "RATE::2", cluster: "RATE", durability: "standard", ageDays: 45,
    text: "A leaky bucket processes requests at a strictly constant rate regardless of how bursty the incoming traffic is, smoothing bursts out instead of allowing them the way a token bucket does." },
  { marker: "RATE::3", cluster: "RATE", durability: "standard", ageDays: 30,
    text: "A sliding window log tracks the exact timestamp of every request in the recent window, giving an accurate count at the cost of more memory than a simple fixed counter." },
  { marker: "RATE::4", cluster: "RATE", durability: "persistent", ageDays: 80,
    text: "A client hitting a 429 should back off exponentially with jitter rather than retrying immediately, and should honor a Retry-After header if the server sends one instead of guessing its own delay." },
  { marker: "RATE::5", cluster: "RATE", durability: "standard", ageDays: 12,
    text: "A fixed window counter resets to zero at a clock boundary, which lets a client send double the intended limit by timing requests around the reset instant — a sliding window avoids that edge effect." },
  { marker: "RATE::6", cluster: "RATE", durability: "ephemeral", ageDays: 7,
    text: "Rate limiting by API key rather than by IP address is what actually protects a shared endpoint, since a legitimate high-traffic customer and an abusive one can share the same NAT'd IP address." },

  // ── DEPLOY: container/k8s deployment strategies (8) ───────────────────────
  { marker: "DEPLOY::1", cluster: "DEPLOY", durability: "persistent", ageDays: 90,
    text: "A canary deployment shifts a small percentage of live traffic to the new version first, watches its error rate and latency against the baseline, and only then ramps the rest of the traffic over.",
    note: "STRESS CORRECT (vs DEPLOY::2): older + persistent durability." },
  { marker: "DEPLOY::2", cluster: "DEPLOY", durability: "permanent", ageDays: 2,
    text: "A blue-green deployment keeps two full environments running and switches all traffic over at once by flipping a router or load balancer, making rollback as fast as flipping it back.",
    note: "STRESS DISTRACTOR for DEPLOY::1: fresh + permanent, adjacent deployment strategy." },
  { marker: "DEPLOY::3", cluster: "DEPLOY", durability: "standard", ageDays: 35,
    text: "A rolling update replaces old pods with new ones a few at a time, so the service never has zero capacity, but it does mean old and new versions briefly serve traffic side by side." },
  { marker: "DEPLOY::4", cluster: "DEPLOY", durability: "standard", ageDays: 20,
    text: "A recreate strategy tears down every old instance before starting any new one, guaranteeing no version overlap at the cost of real downtime during the switch — fine for a maintenance window, not for a live service." },
  { marker: "DEPLOY::5", cluster: "DEPLOY", durability: "standard", ageDays: 48,
    text: "A readiness probe that fails keeps a pod out of the load balancer's rotation without restarting it, which is exactly what should gate a rolling update — a pod isn't 'up' until it says it can actually serve traffic." },
  { marker: "DEPLOY::6", cluster: "DEPLOY", durability: "standard", ageDays: 12,
    text: "Rolling back a Kubernetes deployment to the previous revision is usually one command because Kubernetes keeps a revision history by default — the fast path assumes you kept that history around instead of pruning it." },
  { marker: "DEPLOY::7", cluster: "DEPLOY", durability: "standard", ageDays: 28,
    text: "A canary's traffic split is only useful if the metrics you're watching are sliced by version — an aggregate error rate across both old and new pods can hide a canary regression in the noise.",
    note: "Near-dup facet of DEPLOY::1 (canary observability detail)." },
  { marker: "DEPLOY::8", cluster: "DEPLOY", durability: "standard", ageDays: 18,
    text: "Blue-green needs double the infrastructure capacity during the cutover window, which is the tradeoff for being able to roll back instantly by just flipping the router back to the old environment.",
    note: "Near-dup facet of DEPLOY::2." },

  // ── GIT: git branching workflows (8) ──────────────────────────────────────
  { marker: "GIT::1", cluster: "GIT", durability: "standard", ageDays: 50,
    text: "Trunk-based development keeps everyone committing small changes directly to main (or short-lived branches merged within a day), leaning on feature flags instead of long-lived branches to hide unfinished work.",
    note: "STRESS CORRECT (vs GIT::2): older + standard durability." },
  { marker: "GIT::2", cluster: "GIT", durability: "permanent", ageDays: 3,
    text: "Gitflow keeps separate long-lived develop and main branches plus dedicated release and hotfix branches, which gives more process ceremony than most teams need for a service that ships continuously.",
    note: "STRESS DISTRACTOR for GIT::1: fresh + permanent, adjacent workflow." },
  { marker: "GIT::3", cluster: "GIT", durability: "standard", ageDays: 25,
    text: "A feature-branch workflow cuts a new branch per unit of work and merges it back via pull request once reviewed, which is lighter than Gitflow but still means work-in-progress lives off of main until it lands." },
  { marker: "GIT::4", cluster: "GIT", durability: "standard", ageDays: 40,
    text: "Rebasing a feature branch onto main rewrites its commits on top of the latest main, producing a clean linear history, while merging main into the branch instead preserves the true chronological history but adds merge commits." },
  { marker: "GIT::5", cluster: "GIT", durability: "standard", ageDays: 15,
    text: "Cherry-picking takes one specific commit from another branch and replays just that change onto the current branch, which is the right tool for backporting a single fix without pulling in everything else that branch has." },
  { marker: "GIT::6", cluster: "GIT", durability: "standard", ageDays: 22,
    text: "Squash-merging collapses an entire branch's commits into one on main, trading away the fine-grained commit history for a clean, one-line-per-feature main log that's much easier to skim or revert.",
    note: "Near-dup facet of GIT::4 (history-shape tradeoff)." },
  { marker: "GIT::7", cluster: "GIT", durability: "standard", ageDays: 8,
    text: "Git bisect binary-searches your commit history by checking out a midpoint, having you mark it good or bad, and narrowing the range each time — it finds the exact commit that introduced a regression in log2(n) steps." },
  { marker: "GIT::8", cluster: "GIT", durability: "standard", ageDays: 32,
    text: "A rebase rewrites commit hashes, so rebasing a branch anyone else has already pulled forces them into a painful history reconciliation — the rule of thumb is never rebase a branch other people are also working on.",
    note: "Near-dup facet of GIT::4 (rebase caveat)." },
];

// ─── Ground-truth queries (30) ──────────────────────────────────────────────
export const QUERIES: GroundTruthQuery[] = [
  // ── stress (7): durability/recency composite-vs-raw discriminators ───────
  { kind: "stress", expectMarker: "CONSENSUS::1",
    q: "How does a cluster pick which single node gets to lead for a while?",
    note: "vs CONSENSUS::8 (fresh/permanent 'staying leader' fact)." },
  { kind: "stress", expectMarker: "COFFEE::1",
    q: "What's the classic manual method for a clean, bright cup using a paper filter and a slow, careful pour?",
    note: "vs COFFEE::6 (fresh/permanent AeroPress, also paper-filtered)." },
  { kind: "stress", expectMarker: "FIN::1",
    q: "What's the cheapest hands-off way to own a slice of the entire stock market?",
    note: "vs FIN::4 (fresh/permanent rebalancing fact, same cluster)." },
  { kind: "stress", expectMarker: "PLANT::1",
    q: "What's a good hard-to-kill houseplant for someone who always forgets to water?",
    note: "vs PLANT::3 (fresh/permanent pothos, also 'easy plant')." },
  { kind: "stress", expectMarker: "AUTH::1",
    q: "How does a web app hand off a user's login to a third-party identity provider without the app ever seeing the password?",
    note: "vs AUTH::3 (fresh/permanent JWT fact, adjacent auth topic)." },
  { kind: "stress", expectMarker: "DEPLOY::1",
    q: "What deployment approach tests a new version on a small slice of real traffic before rolling it out to everyone?",
    note: "vs DEPLOY::2 (fresh/permanent blue-green, adjacent strategy)." },
  { kind: "stress", expectMarker: "GIT::1",
    q: "What git workflow has everyone committing small changes straight to main behind feature flags instead of long-lived branches?",
    note: "vs GIT::2 (fresh/permanent Gitflow, adjacent workflow)." },

  // ── trap (3): lexical-overlap-but-wrong-domain (BM25/hybrid stress) ──────
  { kind: "trap", expectMarker: "FIN::1",
    q: "What's the cheapest way to track the whole stock market instead of trying to pick individual winners?",
    note: "shares 'index'/'market' vocab with the DBIDX cluster." },
  { kind: "trap", expectMarker: "DBIDX::1",
    q: "What data structure lets a database find a row in logarithmic time instead of scanning the whole table?",
    note: "shares 'index' vocab with the FIN cluster." },
  { kind: "trap", expectMarker: "GIT::3",
    q: "What's a common workflow for isolating one unit of work per branch before merging it back to main?",
    note: "shares 'branch' vocab with GARDEN::1 (tomato pruning)." },

  // ── hard (6): genuine near-duplicate disambiguation, non-adversarial age ─
  { kind: "hard", expectMarker: "PLANT::4",
    q: "What are the telltale signs my plant is dying from too much water rather than too little?",
    note: "vs PLANT::9 (gnat-specific facet) and PLANT::5 (underwatering contrast)." },
  { kind: "hard", expectMarker: "DBIDX::5",
    q: "Why would the same two columns need a different index shape depending on which query is running?",
    note: "vs DBIDX::3 (covering index — both about index-shape-per-query)." },
  { kind: "hard", expectMarker: "AUTH::3",
    q: "What's the real risk if someone steals my signed access token before it expires?",
    note: "vs AUTH::8 (expiry-vs-revocation near-dup facet)." },
  { kind: "hard", expectMarker: "GIT::6",
    q: "What do I give up by squashing a branch's commits down to one before merging?",
    note: "vs GIT::4 (rebase/merge history-shape near-dup)." },
  { kind: "hard", expectMarker: "DEPLOY::5",
    q: "How do I stop a rollout from sending traffic to a pod before it's actually ready to serve?",
    note: "vs DEPLOY::3 (rolling update — both gate rollout traffic)." },
  { kind: "hard", expectMarker: "COFFEE::7",
    q: "What's a quick technique for getting a more even extraction out of a manual drip brew?",
    note: "vs COFFEE::1 (pour-over basics — bloom is a facet of the same method)." },

  // ── clean (14): unambiguous single-best-answer sanity floor ──────────────
  { kind: "clean", expectMarker: "CONSENSUS::2",
    q: "When is it actually safe to say a replicated write has taken effect across the cluster?", note: "" },
  { kind: "clean", expectMarker: "CONSENSUS::3",
    q: "How does Paxos structure its two rounds of agreement?", note: "" },
  { kind: "clean", expectMarker: "CONSENSUS::4",
    q: "Why does a consensus cluster stop accepting writes entirely during a bad network split instead of picking a side?", note: "" },
  { kind: "clean", expectMarker: "CONSENSUS::6",
    q: "How is ZooKeeper's atomic broadcast protocol similar to Raft?", note: "" },
  { kind: "clean", expectMarker: "ENG::2",
    q: "How do you keep a long meeting-based disagreement from dragging on forever on an engineering team?", note: "" },
  { kind: "clean", expectMarker: "ENG::3",
    q: "What actually distinguishes a tech lead's job from just being the most senior engineer?", note: "" },
  { kind: "clean", expectMarker: "TEA::1",
    q: "Why does green tea turn bitter if you steep it like you would black tea?", note: "" },
  { kind: "clean", expectMarker: "FIN::5",
    q: "Why is an emergency fund supposed to sit in cash instead of being invested?", note: "" },
  { kind: "clean", expectMarker: "FIN::7",
    q: "What's the actual tax advantage that makes an HSA worth maxing out?", note: "" },
  { kind: "clean", expectMarker: "DBIDX::6",
    q: "Why does adding a database index make writes slower even though it speeds up reads?", note: "" },
  { kind: "clean", expectMarker: "GARDEN::4",
    q: "Why should outdoor garden beds get watered deeply and rarely instead of a light daily sprinkle?", note: "" },
  { kind: "clean", expectMarker: "RATE::1",
    q: "What lets a client send occasional bursts above its average allowed rate without getting throttled?", note: "" },
  { kind: "clean", expectMarker: "RATE::4",
    q: "What should a client do differently when a server responds with a 429 rather than just retrying immediately?", note: "" },
  { kind: "clean", expectMarker: "GIT::7",
    q: "What's the fast way to find exactly which commit introduced a regression out of hundreds of candidates?", note: "" },
];

// Sanity: every expectMarker must resolve to a real corpus record (checked at
// harness startup too, but cheap to assert here for anyone importing this
// module directly).
const MARKERS = new Set(CORPUS.map(c => c.marker));
for (const { expectMarker, q } of QUERIES) {
  if (!MARKERS.has(expectMarker)) {
    throw new Error(`corpus.ts: query "${q}" expects unknown marker ${expectMarker}`);
  }
}
