/-
Authoritative process model: backend-attempt timeout/cancellation
semantics for the stateless judgment service. EVERY backend attempt gets
one generation-progress idle clock (native classifier default 10,000 ms,
LLM default 15,000 ms) plus an optional absent-by-default hard clock
(`modelTimeoutMs`). Both clocks start at attempt admission, span setup,
credential readiness, EVERY question and the single permitted repair per
question. Only nonempty generated text, reasoning or tool-argument
deltas — or a completed validated question answer — renew the idle
clock; heartbeats, headers, empty/lifecycle events, request starts and
setup completion never do. The hard clock never renews; an omitted hard
limit means no hard limit, and no combined primary-plus-alternate budget
exists. An automatic-mode OPERATION owns caller cancellation across at
most two sequential backend attempts; the unused alternate may run after
the preferred attempt ends and gets fresh independent clocks of its own.
This file models ONLY that slice. Self-contained: `lean --run` executes
the witness.
-/
set_option autoImplicit false

namespace TimeoutSemantics

/-- The two real backend families, each with its own idle default. -/
inductive BackendKind where
  | llm
  | nativeClassifier
  deriving DecidableEq, Repr

/-- Default idle window in milliseconds per backend family. -/
def defaultIdleMs : BackendKind → Nat
  | .llm => 15_000
  | .nativeClassifier => 10_000

/-- Whether an observed event renews the idle clock. -/
inductive ProgressEvent where
  /-- Nonempty normalized generated text delta. -/
  | textDelta
  /-- Nonempty normalized reasoning/thinking delta. -/
  | thinkingDelta
  /-- Nonempty normalized tool-argument delta. -/
  | toolcallDelta
  /-- A complete question answer passed validation. -/
  | completedAnswer
  /-- Protocol heartbeat/keepalive byte. -/
  | heartbeat
  /-- Header, empty or lifecycle event with no payload. -/
  | emptyEvent
  /-- New request dispatch, retry start or setup completion. -/
  | requestStart
  deriving DecidableEq, Repr

/-- Only genuine generation progress renews idle: nonempty deltas or a
    validated completed answer. Heartbeats, empty events and request
    starts never renew it. -/
def renewsIdle : ProgressEvent → Bool
  | .textDelta => true
  | .thinkingDelta => true
  | .toolcallDelta => true
  | .completedAnswer => true
  | _ => false

/-- One timed backend attempt of an operation. The idle window is always
    present; the hard window is optional (`none` = no hard limit). -/
structure TimedAttempt where
  backend : BackendKind
  idleMs : Nat
  /-- Optional absolute cap counted from attempt admission. -/
  hardMs : Option Nat

/-- Wall-clock facts about one in-flight attempt. Both counters measure
    from the same admission instant. -/
structure AttemptClock where
  /-- Milliseconds since attempt admission (covers setup/auth/all
      questions/repair — never reset). -/
  elapsed : Nat
  /-- Milliseconds since the last genuine generation progress event. -/
  sinceProgress : Nat

/-- Attempt must stop now: the hard cap fires on total elapsed since
    admission when configured; the idle cap fires when genuine progress
    went silent for the full window. Whichever expires first wins. -/
def mustStop (a : TimedAttempt) (clock : AttemptClock) : Bool :=
  clock.sinceProgress >= a.idleMs ||
    (match a.hardMs with
     | some ms => clock.elapsed >= ms
     | none => false)

/-- Any renewing event resets the idle counter to zero; elapsed (and
    therefore the hard clock) keeps counting from admission. -/
def onEvent (clock : AttemptClock) (event : ProgressEvent) : AttemptClock :=
  if renewsIdle event then { clock with sinceProgress := 0 } else clock

/-! ## Idle-clock facts -/

/-- Heartbeats never renew idle: a stream that only emits keepalives
    still expires at the idle window. -/
theorem heartbeat_no_renew (clock : AttemptClock) :
    onEvent clock .heartbeat = clock := by
  simp [onEvent, renewsIdle]

/-- Empty/lifecycle events never renew idle. -/
theorem empty_event_no_renew (clock : AttemptClock) :
    onEvent clock .emptyEvent = clock := by
  simp [onEvent, renewsIdle]

/-- Request dispatches, retries and setup completion never renew idle. -/
theorem request_start_no_renew (clock : AttemptClock) :
    onEvent clock .requestStart = clock := by
  simp [onEvent, renewsIdle]

/-- Every genuine progress event resets the idle counter. -/
theorem progress_renews (clock : AttemptClock) (event : ProgressEvent)
    (h : renewsIdle event = true) :
    (onEvent clock event).sinceProgress = 0 := by
  simp [onEvent, h]

/-- Generation that stays within each idle window outlasts any fixed
    total when no hard limit is configured: a stream still progressing
    at `n` elapsed need not stop. -/
theorem no_hard_cap_no_total (idle n : Nat) (h : idle > 0) :
    mustStop ⟨.llm, idle, none⟩ ⟨n, idle - 1⟩ = false := by
  simp [mustStop]
  omega

/-- Silence for the full idle window stops the attempt even when total
    elapsed is still short — heartbeats cannot rescue it. -/
theorem silent_gap_stops (idle elapsed : Nat) :
    mustStop ⟨.llm, idle, none⟩ ⟨elapsed, idle⟩ = true := by
  simp [mustStop]

/-- A non-streaming native adapter producing no progress for its idle
    window expires while waiting for its complete answer. -/
theorem native_silence_stops (idle elapsed : Nat) :
    mustStop ⟨.nativeClassifier, idle, none⟩ ⟨elapsed, idle⟩ = true := by
  simp [mustStop]

/-! ## Hard-clock facts -/

/-- The hard cap is an absolute deadline from admission: it fires on
    total elapsed even while genuine progress continues, and never
    renews. -/
theorem hard_cap_absolute (idle hard : Nat) :
    mustStop ⟨.llm, idle, some hard⟩ ⟨hard, 0⟩ = true := by
  simp [mustStop]

/-- Genuine progress cannot extend the hard deadline: recent activity
    with elapsed past the cap still stops. -/
theorem hard_cap_ignores_progress (idle hard : Nat) :
    mustStop ⟨.llm, idle, some hard⟩ ⟨hard, 1⟩ = true := by
  simp [mustStop]

/-- An idle expiry wins before the hard cap when the hard cap is longer:
    whichever expires first ends the attempt. -/
theorem idle_expires_first (idle hard : Nat) (_h : hard > idle) :
    mustStop ⟨.llm, idle, some hard⟩ ⟨idle, idle⟩ = true := by
  simp [mustStop]

/-! ## Failover slice

One OPERATION admits at most one backend switch. Operation-level caller
cancellation is terminal for both attempts; an eligible failure only
ends THAT attempt and may admit the unused alternate, which receives
fresh independent clocks from its own admission — never the primary's
exhausted deadline or a shared leftover budget. -/

/-- What happened to one backend attempt of an operation. -/
inductive AttemptOutcome where
  /-- Completed with a business result (including valid negative or
      all-dropped views: success, never failover permission). -/
  | completed
  /-- An eligible backend failure (idle/hard expiry, unavailable or
      context overflow): admits the unused alternate. -/
  | eligibleFailure
  /-- The operation caller cancelled: terminal for the whole operation. -/
  | operationCancelled
  deriving DecidableEq, Repr

/-- An operation's routing decision after one attempt, given whether an
    unused alternate backend family remains: `true` = start the
    alternate (the one permitted switch). -/
def switchesBackend (outcome : AttemptOutcome) (alternateRemains : Bool) :
    Bool :=
  match outcome with
  | .completed => false           -- stop on success
  | .operationCancelled => false  -- terminal abort, no alternate
  | .eligibleFailure => alternateRemains

/-- The alternate's clocks start at zero from its own admission. -/
def freshClock (_primary : AttemptClock) : AttemptClock :=
  { elapsed := 0, sinceProgress := 0 }

/-- A fresh alternate attempt is not immediately timed out, even when
    the primary attempt expired with the same timing parameters. -/
theorem fresh_alternate_not_stopped (a : TimedAttempt)
    (hidle : a.idleMs > 0) (hhard : ∀ ms, a.hardMs = some ms → ms > 0)
    (primary : AttemptClock)
    (_h : mustStop a primary = true) :
    mustStop a (freshClock primary) = false := by
  simp [mustStop, freshClock]
  refine ⟨by omega, ?_⟩
  cases hh : a.hardMs with
  | none => simp
  | some ms => simp; have := hhard ms hh; omega

/-- Eligible failure permits at most one alternate; completion and
    operation cancellation never start one, and when no alternate
    remains nothing starts. -/
theorem bounded_switching :
    (∀ alt, switchesBackend .completed alt = false) ∧
    (∀ alt, switchesBackend .operationCancelled alt = false) ∧
    switchesBackend .eligibleFailure true = true ∧
    switchesBackend .eligibleFailure false = false := by
  refine ⟨fun _ => rfl, fun _ => rfl, rfl, rfl⟩

/-- Caller cancellation observed between attempts ends the operation
    without dispatching the alternate, even though an eligible failure
    would have started it. -/
theorem cancel_between_attempts_wins :
    switchesBackend .operationCancelled true = false ∧
      switchesBackend .eligibleFailure true = true := by
  exact ⟨rfl, rfl⟩

/-- The alternate keeps its whole budget: its hard cap counts from its
    own admission, so an exhausted primary cap never subtracts from it. -/
theorem alternate_whole_budget (idle hard elapsed : Nat)
    (_h : elapsed >= hard) (hidle : idle > 0) (hhard : hard > 0) :
    mustStop ⟨.llm, idle, some hard⟩
      (freshClock ⟨elapsed, elapsed⟩) = false := by
  simp [mustStop, freshClock]
  omega

/-! ## Caller cancellation -/

/-- What settled an attempt: cancellation is orthogonal to both clocks
    and always wins. -/
inductive TimeoutVerdict where
  | settled
  | callerCancelled
  | timedOut
  deriving DecidableEq, Repr

def attemptOutcome (cancelled : Bool) (a : TimedAttempt)
    (clock : AttemptClock) : TimeoutVerdict :=
  if cancelled then .callerCancelled
  else if mustStop a clock then .timedOut
  else .settled

theorem caller_cancel_wins (a : TimedAttempt) (clock : AttemptClock) :
    attemptOutcome true a clock = .callerCancelled := by
  simp [attemptOutcome]

/-- Top-level correctness claim for this slice: heartbeats and empty
    events never renew idle; only genuine progress does; idle silence
    stops at the window; a configured hard cap is absolute from admission
    and ignores progress; no hard cap means no total bound; the alternate
    gets fresh independent clocks; and caller cancellation always
    settles first. -/
theorem timeout_slice_is_correct :
    (∀ clock : AttemptClock,
      onEvent clock .heartbeat = clock ∧
      onEvent clock .emptyEvent = clock ∧
      onEvent clock .requestStart = clock) ∧
    (∀ idle n : Nat, idle > 0 →
      mustStop ⟨.llm, idle, none⟩ ⟨n, idle - 1⟩ = false ∧
      mustStop ⟨.llm, idle, none⟩ ⟨0, idle⟩ = true ∧
      mustStop ⟨.nativeClassifier, idle, none⟩ ⟨0, idle⟩ = true) ∧
    (∀ idle hard : Nat,
      mustStop ⟨.llm, idle, some hard⟩ ⟨hard, 0⟩ = true) ∧
    (∀ a : TimedAttempt, ∀ clock : AttemptClock,
      attemptOutcome true a clock = .callerCancelled) := by
  refine ⟨?_, ?_, ?_, ?_⟩
  · intro clock
    exact ⟨heartbeat_no_renew clock, empty_event_no_renew clock,
      request_start_no_renew clock⟩
  · intro idle n h
    refine ⟨?_, ?_, ?_⟩
    · exact no_hard_cap_no_total idle n h
    · exact silent_gap_stops idle 0
    · exact native_silence_stops idle 0
  · intro idle hard
    exact hard_cap_absolute idle hard
  · intro a clock
    exact caller_cancel_wins a clock

/-- Executable witness: the named scenarios run deterministically and
    print the modeled outcomes. -/
def main : IO Unit := do
  let idle := defaultIdleMs .llm
  IO.println s!"llm default idle={idle}ms, native default idle={defaultIdleMs .nativeClassifier}ms"
  IO.println s!"llm(15s idle, no hard) active at 60s -> mustStop={mustStop ⟨.llm, 15_000, none⟩ ⟨60_000, 14_999⟩}"
  IO.println s!"llm silent 15s gap (heartbeats only) at 60s -> mustStop={mustStop ⟨.llm, 15_000, none⟩ ⟨60_000, 15_000⟩}"
  IO.println s!"native(10s idle) silent at 10s -> mustStop={mustStop ⟨.nativeClassifier, 10_000, none⟩ ⟨10_000, 10_000⟩}"
  IO.println s!"llm hard=20s with progress at 20s -> mustStop={mustStop ⟨.llm, 15_000, some 20_000⟩ ⟨20_000, 1_000⟩}"
  let event : ProgressEvent := .heartbeat
  IO.println s!"heartbeat renews idle -> {renewsIdle event}, textDelta renews -> {renewsIdle .textDelta}"
  let expired : AttemptClock := { elapsed := 30_000, sinceProgress := 0 }
  IO.println s!"primary eligible failure -> switches(alternate remains)={switchesBackend .eligibleFailure true}"
  IO.println s!"primary completed -> switches={switchesBackend .completed true}"
  IO.println s!"operation cancelled between attempts -> switches={switchesBackend .operationCancelled true}"
  IO.println s!"fresh alternate (hard=30s) at primary expiry -> mustStop={mustStop ⟨.nativeClassifier, 10_000, some 30_000⟩ (freshClock expired)}"
  IO.println s!"cancelled llm attempt -> {repr (attemptOutcome true ⟨.llm, 15_000, none⟩ expired)}"

end TimeoutSemantics

/-- Executable witness entry point. -/
def main : IO Unit := TimeoutSemantics.main

#print axioms TimeoutSemantics.timeout_slice_is_correct
#print axioms TimeoutSemantics.fresh_alternate_not_stopped
#print axioms TimeoutSemantics.bounded_switching
#print axioms TimeoutSemantics.alternate_whole_budget
#print axioms TimeoutSemantics.cancel_between_attempts_wins
