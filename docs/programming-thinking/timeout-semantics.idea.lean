/-
Authoritative process model: backend-specific timeout/cancellation
semantics for the judgment service timeout slice. LLM work waits on
transport inactivity (including a bounded first-response wait and the
bounded setup phase that precedes it); native classifier work waits on one
absolute whole-call deadline that is never reset across internal stages.
An automatic-mode OPERATION owns caller cancellation across at most two
backend attempts: each ATTEMPT gets a fresh window under its own policy,
the unused alternate may run after the preferred attempt's window expires,
and no bounded total wall clock is claimed over an LLM attempt. This file
models ONLY that slice; it does not claim the managed-review lifecycle
proved. Self-contained: lean --run executes the witness.
-/
set_option autoImplicit false

namespace TimeoutSemantics

/-- The two real backend families with different waiting contracts. -/
inductive BackendKind where
  | llm
  | nativeClassifier
  deriving DecidableEq, Repr

/-- What the caller's `timeoutMs` means, chosen by the selected backend. -/
inductive WaitPolicy where
  /-- LLM: inactivity timeout — abort only after `ms` with no observed
      transport activity. Continuous raw activity (prose, reasoning,
      tool-argument and protocol/SSE-keepalive bytes) outlasts any total
      wall clock. Covers the bounded wait for the first byte too. -/
  | inactivity (ms : Nat)
  /-- Native classifier: absolute deadline — abort once total elapsed
      time since logical-call start exceeds `ms`, regardless of activity.
      Not reset across internal stages or subdivisions. -/
  | absolute (ms : Nat)
  deriving DecidableEq, Repr

/-- The policy is a function of the selected backend, not of the option
    name: both interpretations read the same `timeoutMs` value. -/
def policyFor (backend : BackendKind) (timeoutMs : Nat) : WaitPolicy :=
  match backend with
  | .llm => .inactivity timeoutMs
  | .nativeClassifier => .absolute timeoutMs

/-- One timed provider request inside a logical call. -/
structure TimedAttempt where
  backend : BackendKind
  timeoutMs : Nat

/-- What can make an attempt settle before its natural outcome. -/
inductive TimeoutVerdict where
  | settled
  | callerCancelled
  | timedOut
  deriving DecidableEq, Repr

/-- Wall-clock facts about one in-flight attempt. -/
structure AttemptClock where
  /-- Milliseconds since the attempt began. -/
  elapsed : Nat
  /-- Milliseconds since the last observed transport activity byte/event.
      For an attempt that has not yet produced its first byte this equals
      `elapsed` — the bounded first-response wait is the same clock. -/
  sinceActivity : Nat

/-- Attempt must stop now: inactivity fires only when the stream went
    silent for the full window; absolute fires on total elapsed time. -/
def mustStop (a : TimedAttempt) (clock : AttemptClock) : Bool :=
  match policyFor a.backend a.timeoutMs with
  | .inactivity ms => clock.sinceActivity >= ms
  | .absolute ms => clock.elapsed >= ms

/-- Transport activity resets the LLM clock only. -/
def onActivity (a : TimedAttempt) (clock : AttemptClock) : AttemptClock :=
  match policyFor a.backend a.timeoutMs with
  | .inactivity _ => { clock with sinceActivity := 0 }
  | .absolute _ => clock

/-- LLM continuous activity can outlast any fixed total duration: pick a
    total of `2 * ms` with the last byte arriving just inside the window. -/
theorem llm_activity_outlasts_total (ms : Nat) (hms : ms > 0) :
    mustStop ⟨.llm, ms⟩ ⟨2 * ms, ms - 1⟩ = false := by
  simp [mustStop, policyFor]
  omega

/-- The same clock under a native absolute deadline must stop: the total
    elapsed time alone decides, regardless of recent activity. -/
theorem native_absolute_ignores_activity (ms : Nat) (hms : ms > 0) :
    mustStop ⟨.nativeClassifier, ms⟩ ⟨2 * ms, ms - 1⟩ = true := by
  simp [mustStop, policyFor]
  omega

/-- Activity observed inside the window resets the LLM inactivity clock. -/
theorem llm_activity_resets (ms : Nat) (clock : AttemptClock) :
    (onActivity ⟨.llm, ms⟩ clock).sinceActivity = 0 := by
  simp [onActivity, policyFor]

/-- Activity does not extend a native absolute deadline. -/
theorem native_activity_no_reset (ms : Nat) (clock : AttemptClock) :
    onActivity ⟨.nativeClassifier, ms⟩ clock = clock := by
  simp [onActivity, policyFor]

/-- An LLM stream silent for the full window must stop even when its total
    duration is still short — no first-byte or mid-stream gap may hang. -/
theorem llm_silent_gap_stops (ms elapsed : Nat) (_h : elapsed < ms) :
    mustStop ⟨.llm, ms⟩ ⟨elapsed, ms⟩ = true := by
  simp [mustStop, policyFor]

/-- Two successive questions are separate attempts: a fresh attempt's
    inactivity clock starts at zero, so a second question is not billed
    for the first question's elapsed time. -/
theorem llm_question_fresh_clock (ms : Nat) (hms : ms > 0) :
    mustStop ⟨.llm, ms⟩ ⟨0, 0⟩ = false := by
  simp [mustStop, policyFor]
  omega

/-- In-flight join safety: a caller joining shared pending work waits on
    its own signal; a joiner whose required inactivity window differs from
    the owner's may not silently inherit the owner's wait. Modeled by
    making the joinable flag a function of policy equality. -/
def joinable (owner waiter : TimedAttempt) : Bool :=
  policyFor owner.backend owner.timeoutMs ==
    policyFor waiter.backend waiter.timeoutMs

/-- A silent gap stops the LLM attempt even when total elapsed is below
    the window: inactivity, not duration, is the trigger. `elapsed` only
    witnesses that the silent clock is the operative one. -/
theorem join_compatible_when_policies_match (ms : Nat) :
    joinable ⟨.llm, ms⟩ ⟨.llm, ms⟩ = true := by
  simp [joinable, policyFor]

theorem join_incompatible_when_policies_differ (ms ms' : Nat)
    (h : ms ≠ ms') :
    joinable ⟨.llm, ms⟩ ⟨.llm, ms'⟩ = false := by
  simp [joinable, policyFor]
  omega

/-- Caller cancellation is orthogonal to both policies: an aborted attempt
    settles as cancelled regardless of which clock would fire later. -/
def attemptOutcome (cancelled : Bool) (a : TimedAttempt)
    (clock : AttemptClock) : TimeoutVerdict :=
  if cancelled then .callerCancelled
  else if mustStop a clock then .timedOut
  else .settled

theorem caller_cancel_wins (a : TimedAttempt) (clock : AttemptClock) :
    attemptOutcome true a clock = .callerCancelled := by
  simp [attemptOutcome]

/-- Top-level correctness claim for this slice: the same `timeoutMs`
    selects inactivity waiting for LLM and absolute waiting for the native
    backend; LLM activity defeats a total clock and silence defeats
    activity; native waits never reset; joins require equal policies; and
    caller cancellation always settles first. -/
theorem timeout_slice_is_correct :
    (∀ ms : Nat, ms > 0 →
      mustStop ⟨.llm, ms⟩ ⟨2 * ms, ms - 1⟩ = false ∧
      mustStop ⟨.nativeClassifier, ms⟩ ⟨2 * ms, ms - 1⟩ = true ∧
      mustStop ⟨.llm, ms⟩ ⟨0, ms⟩ = true ∧
      mustStop ⟨.nativeClassifier, ms⟩ ⟨ms, 0⟩ = true ∧
      (onActivity ⟨.llm, ms⟩ ⟨ms, ms⟩).sinceActivity = 0 ∧
      onActivity ⟨.nativeClassifier, ms⟩ ⟨ms, ms⟩ = ⟨ms, ms⟩) ∧
    (∀ ms ms' : Nat, ms ≠ ms' →
      joinable ⟨.llm, ms⟩ ⟨.llm, ms'⟩ = false) ∧
    (∀ a : TimedAttempt, ∀ clock : AttemptClock,
      attemptOutcome true a clock = .callerCancelled) := by
  refine ⟨?_, ?_, ?_⟩
  · intro ms hms
    refine ⟨?_, ?_, ?_, ?_, ?_, ?_⟩
    · exact llm_activity_outlasts_total ms hms
    · exact native_absolute_ignores_activity ms hms
    · simp [mustStop, policyFor]
    · simp [mustStop, policyFor]
    · exact llm_activity_resets ms ⟨ms, ms⟩
    · exact native_activity_no_reset ms ⟨ms, ms⟩
  · intro ms ms' h
    exact join_incompatible_when_policies_differ ms ms' h
  · intro a clock
    exact caller_cancel_wins a clock

/-! ## Automatic failover slice (add-auto-llm-fallback)

One OPERATION admits at most one backend switch. Operation-level caller
cancellation is terminal for both attempts; a per-attempt window expiry
only ends THAT attempt and may admit the alternate with a fresh window
under the alternate's own policy. No total wall clock bounds an LLM
attempt. -/

/-- What happened to one backend attempt of an operation. -/
inductive AttemptOutcome where
  /-- Completed with a business result (including valid negative or
      all-dropped views: success, never failover permission). -/
  | completed
  /-- The attempt's own window expired (setup or execution timeout). -/
  | windowExpired
  /-- The operation caller cancelled: terminal for the whole operation. -/
  | operationCancelled
  deriving DecidableEq, Repr

/-- An operation's routing decision after one attempt, given whether an
    unused alternate backend family remains: `true` = start the alternate
    (the one permitted switch). -/
def switchesBackend (outcome : AttemptOutcome) (alternateRemains : Bool) :
    Bool :=
  match outcome with
  | .completed => false           -- stop on success
  | .operationCancelled => false  -- terminal abort, no alternate
  | .windowExpired => alternateRemains

/-- The alternate's clock starts at zero: its window is fresh, regardless
    of how much of the preferred attempt's window was consumed. -/
def freshClock (_preferred : AttemptClock) : AttemptClock :=
  { elapsed := 0, sinceActivity := 0 }

/-- A fresh alternate attempt is not immediately timed out, even when the
    preferred attempt expired at the same `ms`. -/
theorem fresh_alternate_not_stopped (b : BackendKind) (ms : Nat)
    (hms : ms > 0) (preferred : AttemptClock)
    (h : mustStop ⟨b, ms⟩ preferred = true) :
    mustStop ⟨b, ms⟩ (freshClock preferred) = false := by
  simp [freshClock, mustStop]
  cases b <;> simp [policyFor] at h ⊢ <;> omega

/-- Window expiry of the preferred attempt permits at most one alternate;
    completion and operation cancellation never start one, and a second
    expiry never cycles back (no alternate remains then). -/
theorem bounded_switching :
    (∀ alt, switchesBackend .completed alt = false) ∧
    (∀ alt, switchesBackend .operationCancelled alt = false) ∧
    switchesBackend .windowExpired true = true ∧
    switchesBackend .windowExpired false = false := by
  refine ⟨fun _ => rfl, fun _ => rfl, rfl, rfl⟩

/-- No bounded total wall clock over an LLM attempt: a stream with
    continuous activity and total elapsed arbitrarily far beyond any
    candidate bound `n` still need not stop. The failover model therefore
    claims only per-attempt windows, never a bounded LLM wall time. -/
theorem no_bounded_llm_wall_clock (ms n : Nat) (hms : ms > 0)
    (hn : n >= 2 * ms) :
    ∃ clock : AttemptClock, clock.elapsed >= n ∧
      mustStop ⟨.llm, ms⟩ clock = false := by
  refine ⟨⟨n, ms - 1⟩, Nat.le_refl n, ?_⟩
  simp [mustStop, policyFor]
  omega

/-- Operation-level caller cancellation is observed between attempts too:
    it ends the operation without starting the alternate, even when the
    preferred attempt's window also expired. -/
theorem cancel_between_attempts_wins :
    switchesBackend .operationCancelled true = false ∧
      switchesBackend .windowExpired true = true := by
  exact ⟨rfl, rfl⟩

def main : IO Unit := do
  let clock : AttemptClock := { elapsed := 60_000, sinceActivity := 29_999 }
  IO.println s!"llm(30s idle) at 60s elapsed, 30s-1ms idle -> mustStop={mustStop ⟨.llm, 30_000⟩ clock}"
  IO.println s!"native(30s) at 60s elapsed, 30s-1ms idle -> mustStop={mustStop ⟨.nativeClassifier, 30_000⟩ clock}"
  IO.println s!"llm silent 30s gap at 5s elapsed -> mustStop={mustStop ⟨.llm, 30_000⟩ ⟨5_000, 30_000⟩}"
  IO.println s!"join llm(30s)/llm(10s) -> joinable={joinable ⟨.llm, 30_000⟩ ⟨.llm, 10_000⟩}"
  IO.println s!"cancelled llm -> {repr (attemptOutcome true ⟨.llm, 30_000⟩ clock)}"
  let expired : AttemptClock := { elapsed := 30_000, sinceActivity := 0 }
  IO.println s!"preferred llm(30s) expired -> switches(alternate remains)={switchesBackend .windowExpired true}"
  IO.println s!"preferred completed -> switches={switchesBackend .completed true}"
  IO.println s!"operation cancelled between attempts -> switches={switchesBackend .operationCancelled true}"
  IO.println s!"fresh alternate clock at preferred expiry -> mustStop(native,30s)={mustStop ⟨.nativeClassifier, 30_000⟩ (freshClock expired)}"

end TimeoutSemantics

/-- Executable witness: the named scenario runs deterministically and
    prints the modeled outcomes. -/
def main : IO Unit := TimeoutSemantics.main

#print axioms TimeoutSemantics.timeout_slice_is_correct
#print axioms TimeoutSemantics.fresh_alternate_not_stopped
#print axioms TimeoutSemantics.bounded_switching
#print axioms TimeoutSemantics.no_bounded_llm_wall_clock
#print axioms TimeoutSemantics.cancel_between_attempts_wins
