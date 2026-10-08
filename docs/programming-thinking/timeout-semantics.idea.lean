/-
Authoritative process model: backend-specific timeout/cancellation
semantics for the judgment service timeout slice. LLM work waits on
transport inactivity (including a bounded first-response wait and the
bounded setup phase that precedes it); native classifier work waits on one
absolute whole-call deadline that is never reset across internal stages.
This file models ONLY that slice; it does not claim the managed-review
lifecycle proved. Self-contained: lean --run executes the witness.
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

def main : IO Unit := do
  let clock : AttemptClock := { elapsed := 60_000, sinceActivity := 29_999 }
  IO.println s!"llm(30s idle) at 60s elapsed, 30s-1ms idle -> mustStop={mustStop ⟨.llm, 30_000⟩ clock}"
  IO.println s!"native(30s) at 60s elapsed, 30s-1ms idle -> mustStop={mustStop ⟨.nativeClassifier, 30_000⟩ clock}"
  IO.println s!"llm silent 30s gap at 5s elapsed -> mustStop={mustStop ⟨.llm, 30_000⟩ ⟨5_000, 30_000⟩}"
  IO.println s!"join llm(30s)/llm(10s) -> joinable={joinable ⟨.llm, 30_000⟩ ⟨.llm, 10_000⟩}"
  IO.println s!"cancelled llm -> {repr (attemptOutcome true ⟨.llm, 30_000⟩ clock)}"

end TimeoutSemantics

/-- Executable witness: the named scenario runs deterministically and
    prints the modeled outcomes. -/
def main : IO Unit := TimeoutSemantics.main

#print axioms TimeoutSemantics.timeout_slice_is_correct
