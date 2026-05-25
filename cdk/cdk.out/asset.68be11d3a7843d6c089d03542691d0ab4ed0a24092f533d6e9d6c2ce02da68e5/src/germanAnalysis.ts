import { BedrockRuntimeClient, ConverseCommand, Message } from '@aws-sdk/client-bedrock-runtime';
import { ToolModels } from './consts';

export interface GermanCorrection {
    type: 'grammar' | 'vocab' | 'usage' | 'pronunciation' | 'register';
    category: string;
    original: string;
    correct: string;
    explanation: string;
}

export interface GermanAnalysisResult {
    summary: string;
    corrections: GermanCorrection[];
    strengths: string[];
    completedStepIds?: string[];
}

export interface ScenarioStep {
    id: string;
    label: string;
}

let bedrockClient: BedrockRuntimeClient | null = null;
function getBedrockClient(): BedrockRuntimeClient {
    if (!bedrockClient) {
        bedrockClient = new BedrockRuntimeClient({
            region: ToolModels.germanAnalysis.region,
        });
    }
    return bedrockClient;
}

const CEFR_GUIDANCE: Record<string, string> = {
    a1: 'A1 (Anfänger): expects only Präsens, Nominativ + Akkusativ, basic vocabulary. Do not flag missing B-level structures; focus on basic word order, gender, conjugation.',
    a2: 'A2 (Grundlegend): expects Perfekt, Dativ, separable verbs, simple subordinate clauses with weil/dass/wenn. Flag verb-final errors in subordinate clauses, wrong haben/sein in Perfekt.',
    b1: 'B1 (Selbstständig): expects Konjunktiv II for politeness, Präteritum in narration, Relativsätze, Passiv. Flag Konjunktiv II form errors, Perfekt/Präteritum register mismatch.',
    b2: 'B2 (Fortgeschritten): expects full Konjunktiv II including past, Genitiv, Partizipialkonstruktionen, indirekte Rede starting with Konjunktiv I. Flag avoidance of Konjunktiv I, weak Genitiv use.',
    c1: 'C1 (Fachkundig): expects Konjunktiv I throughout indirect speech, idiomatic Modalpartikeln, full register flexibility. Flag subtle collocation errors, register mismatches, preposition choices on abstract verbs.',
};

const ANALYSIS_SYSTEM_PROMPT = `You are a language teacher analyzing short spoken utterances from a learner. The text is transcribed from speech and may contain minor ASR errors — be charitable about homophones and obvious mishears.

Output strictly valid JSON matching this shape:
{
  "summary": "one-sentence overall assessment in English",
  "strengths": ["short bullet in English describing what the learner did well"],
  "corrections": [
    {
      "type": "grammar" | "vocab" | "usage" | "pronunciation" | "register",
      "category": "short label in the target language for the error category (e.g. 'Wortstellung', 'Concordância', 'Subjuntivo', 'Passato prossimo')",
      "original": "the exact fragment the learner produced that was wrong",
      "correct": "the corrected fragment",
      "explanation": "one short sentence in English explaining the rule"
    }
  ],
  "completedStepIds": ["ids of any scenario steps the learner has now completed via the cumulative transcript"]
}

Rules:
- **Ignore capitalization entirely.** The text comes from speech recognition — capitalization (or lack of it) is an artifact, never a learner error. Never flag missing capital letters on German nouns, sentence starts, "Ich", proper nouns, or anything else. Compare phrases case-insensitively when deciding what's correct.
- If scenario steps are provided below, return "completedStepIds" with the IDs of any step that the learner has satisfied through their utterances so far (look at the full transcript-so-far if given, otherwise the single utterance). Be conservative — only mark a step done when there is clear evidence in the learner's speech. If no steps are provided, omit "completedStepIds" or return an empty array.
- "strengths" must list ONLY things the learner produced correctly. Never list a phrase as a strength if any part of it is grammatically wrong, non-idiomatic, or L1-interference. If unsure, leave strengths empty.
- Watch for common L1-interference patterns that look superficially correct: "Ich habe X Jahre" (correct: "Ich bin X Jahre alt"), "Ich bin Hunger" (correct: "Ich habe Hunger"), "Ich gehe nach Hause/zur Schule" (correct only with the right preposition), "Ich höre Musik" vs "Ich hörte zu Musik". Flag these as usage errors.
- Skip trivial pronunciation differences and likely ASR artifacts (foreign names, single missing umlauts when the rest is fine).
- Stay calibrated to the learner's CEFR level. Don't flag B-level structures missing at A1.
- "original" must be a literal substring of the learner's utterance.
- Return JSON only — no markdown, no commentary, no code fences.`;

export async function analyzeGerman(
    text: string,
    cefr: string = 'a1',
    scenarioLabel?: string,
    scenarioSteps?: ScenarioStep[],
    transcriptSoFar?: string,
    language: string = 'de'
): Promise<GermanAnalysisResult> {
    const client = getBedrockClient();
    const levelGuidance = CEFR_GUIDANCE[cefr.toLowerCase()] || CEFR_GUIDANCE.a1;
    const langName = ({ de: 'German', pt: 'Brazilian Portuguese', es: 'Latin American Spanish', it: 'Italian', fr: 'Metropolitan French', ru: 'Russian', tr: 'Turkish', hr: 'Croatian', el: 'Modern Greek' } as Record<string, string>)[language.toLowerCase()] || 'German';
    const scenarioLine = scenarioLabel ? `Scenario context: ${scenarioLabel}.` : '';

    const stepsBlock = scenarioSteps && scenarioSteps.length
        ? `\nScenario steps the learner must complete:\n${scenarioSteps.map(s => `- ${s.id}: ${s.label}`).join('\n')}\n`
        : '';

    const transcriptBlock = transcriptSoFar && transcriptSoFar.trim()
        ? `\nCumulative learner speech so far (use this for step completion judgment):\n"""\n${transcriptSoFar.trim()}\n"""\n`
        : '';

    const userMessage = `${scenarioLine}
Target language: ${langName}.
Learner CEFR level: ${cefr.toUpperCase()}.
Level guidance: ${levelGuidance}
${stepsBlock}${transcriptBlock}
Latest learner utterance:
"""
${text}
"""

Analyze and return JSON.`;

    const messages: Message[] = [
        { role: 'user', content: [{ text: userMessage }] },
    ];

    // Bedrock prompt caching — system prompt is identical every call, so we mark a cache point
    // immediately after it. Subsequent calls within ~5 minutes read the cache at ~10% of the
    // input-token cost. Cuts analyzer spend ~50-70% under typical use.
    const commandInput: Record<string, unknown> = {
        modelId: ToolModels.germanAnalysis.modelId,
        messages,
        system: [
            { text: ANALYSIS_SYSTEM_PROMPT },
            { cachePoint: { type: 'default' } },
        ],
        inferenceConfig: {
            maxTokens: 1024,
            temperature: 0.2,
        },
    };

    const command = new ConverseCommand(commandInput as any);
    const response = await client.send(command);
    const outputText = response.output?.message?.content?.[0]?.text || '{}';

    // The model is told to emit pure JSON, but be defensive: strip code fences if any leaked through.
    const cleaned = outputText.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

    let parsed: GermanAnalysisResult;
    try {
        parsed = JSON.parse(cleaned);
    } catch (err) {
        console.error('Failed to parse German analysis JSON:', cleaned);
        return { summary: 'Analysis unavailable.', corrections: [], strengths: [] };
    }

    parsed.corrections = (parsed.corrections || [])
        .filter(c => c && c.original && c.correct)
        // Drop corrections whose only difference is capitalization / punctuation /
        // whitespace. The system prompt already forbids these, but Haiku slips
        // occasionally — this is a hard guarantee at the API boundary.
        .filter(c => !isCapitalizationOnlyDiff(c.original, c.correct));
    parsed.strengths = parsed.strengths || [];
    parsed.summary = parsed.summary || '';
    parsed.completedStepIds = Array.isArray(parsed.completedStepIds) ? parsed.completedStepIds : [];
    return parsed;
}

function isCapitalizationOnlyDiff(original: string, correct: string): boolean {
    const norm = (s: string) =>
        s.toLowerCase()
            .replace(/[\p{P}\p{S}]/gu, '')   // strip punctuation + symbols (Unicode-aware)
            .replace(/\s+/g, ' ')
            .trim();
    return norm(original) === norm(correct);
}
