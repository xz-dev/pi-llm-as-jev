/**
 * Copy-able, self-contained client for the pi-llm-as-jev judgment service.
 *
 * This file is the CANONICAL type source for the public contract (D1):
 * `src/contract.ts` re-exports these types, it does not duplicate them.
 * No dependency on the extension package at runtime. Consumers may copy this
 * file into their own extension instead of importing from `pi-llm-as-jev`.
 */
/** Structural copy of pi-ai `JsonValue`. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
/** Structural copy of pi-ai `JsonObject`. */
export type JsonObject = {
    [key: string]: JsonValue;
};
/** Structural copies of pi-ai classifier question shapes. */
export interface ClassifierChoiceQuestion {
    type: "choice";
    instructions: string;
    criteria: Record<string, string>;
}
export interface ClassifierScoreQuestion {
    type: "score";
    instructions: string;
    criteria: string[];
}
export interface ClassifierBoolQuestion {
    type: "bool";
    instructions: string;
    criteria: {
        true: string;
        false: string;
    };
}
export type ClassifierQuestion = ClassifierChoiceQuestion | ClassifierScoreQuestion | ClassifierBoolQuestion;
/** Structural copies of pi-ai classifier answer shapes. */
export interface ClassifierChoiceAnswer {
    type: "choice";
    choice: string;
    probabilities: Record<string, number>;
    confidence: number;
}
export interface ClassifierScoreAnswer {
    type: "score";
    score: number;
    confidence: number;
}
export interface ClassifierBoolAnswer {
    type: "bool";
    probability: number;
}
export type ClassifierAnswer = ClassifierChoiceAnswer | ClassifierScoreAnswer | ClassifierBoolAnswer;
/** Structural copy of pi-ai `Usage`. */
export interface Usage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** Subset of `cacheWrite` written with 1h retention. Anthropic only. */
    cacheWrite1h?: number;
    /** Subset of `output` reported by providers with a reasoning breakdown. */
    reasoning?: number;
    totalTokens: number;
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
    };
}
export interface EvidenceRecord {
    id: string;
    text: string;
    metadata?: JsonObject;
}
export interface JudgeRequest {
    /** Fixed state; unchanged when evidence is subdivided. */
    state: JsonObject;
    questions: Record<string, ClassifierQuestion>;
    /** Stable unique ids, original order. */
    evidence?: EvidenceRecord[];
}
/**
 * Per-question acceptance rule for native-classifier answers. Replaces (does
 * not stack with) the `minConfidence` default for that question. A
 * `choiceProbability` rule must name an existing choice key.
 */
export type ThresholdRule = {
    metric: "confidence";
    minimum: number;
} | {
    metric: "choiceProbability";
    choice: string;
    minimum: number;
};
export interface JudgeOptions {
    /** Default policy for supported native classifier fields. */
    minConfidence?: number;
    /** Per-question override of `minConfidence`. */
    thresholds?: Record<string, ThresholdRule>;
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Force a review; retries within this token reuse new judgments. */
    fresh?: string;
}
export interface JudgeResult {
    /** Final accepted view only. */
    answers: Record<string, ClassifierAnswer>;
    dropped: string[];
    backend: "classifier" | "llm";
    /** `provider/modelid`. */
    model: string;
    stopReason: "stop" | "error" | "aborted";
    errorMessage?: string;
    contextOverflow?: boolean;
    reuse: {
        hits: number;
        joined: number;
        sent: number;
    };
    /** Reported nested usage only, never invented. */
    usage?: Usage;
}
export interface JudgmentService {
    version: 1;
    judge(req: JudgeRequest, opts?: JudgeOptions): Promise<JudgeResult>;
    availability(): Promise<{
        classifier?: string;
        llm?: string;
    }>;
}
/**
 * Look up the judgment service at call time. Returns `undefined` when the
 * `pi-llm-as-jev` extension is not installed/running.
 */
export declare function getJudgmentService(): JudgmentService | undefined;
