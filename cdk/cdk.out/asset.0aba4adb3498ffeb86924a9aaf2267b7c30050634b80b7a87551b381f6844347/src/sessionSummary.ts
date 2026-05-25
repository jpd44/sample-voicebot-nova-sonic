import { BedrockRuntimeClient, ConverseCommand, Message } from '@aws-sdk/client-bedrock-runtime';
import { ToolModels } from './consts';

export interface LearnerProfile {
    name?: string;
    age?: string;
    city?: string;
    country?: string;
    occupation?: string;
    languages?: string[];
    hobbies?: string[];
    family?: string;
    learningGoals?: string;
    observedErrors?: string[];
    facts?: string[];
}

export interface SessionSummaryResult {
    summary: string;
    strengths: string[];
    weaknesses: string[];
    suggestions: string[];
    profile: LearnerProfile;
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

const LANG_NAMES: Record<string, string> = {
    de: 'German',
    pt: 'Brazilian Portuguese',
    es: 'Latin American Spanish',
    it: 'Italian',
    fr: 'Metropolitan French',
    ru: 'Russian',
    tr: 'Turkish',
};

const SUMMARY_SYSTEM_PROMPT = `You are a language tutor analyzing a learner's spoken conversation. The transcript is what the learner said in their target language, mixed with the assistant's replies. You produce a coaching report AND extract durable facts about the learner.

Output strictly valid JSON matching this shape:
{
  "summary": "2-3 sentence overview of the conversation, written for the learner (you-form, English)",
  "strengths": ["short English bullet — concrete thing they did well"],
  "weaknesses": ["short English bullet — recurring error or gap, named with the actual target-language grammar term in parentheses"],
  "suggestions": ["one or two actionable next steps the learner can take"],
  "profile": {
    "name": "...",
    "age": "...",
    "city": "...",
    "country": "...",
    "occupation": "...",
    "languages": ["..."],
    "hobbies": ["..."],
    "family": "...",
    "learningGoals": "...",
    "observedErrors": ["short tag like 'verb-final in weil-clauses', 'haben vs sein in Perfekt'"],
    "facts": ["any other durable fact worth remembering about the learner"]
  }
}

Rules:
- **Ignore capitalization entirely.** The transcript comes from speech recognition — capitalization is an artifact, never a learner error. Never list capitalization as a weakness.
- Only populate profile fields the learner actually mentioned. Omit fields that weren't covered (do not invent).
- If a profile field was already set in the previous profile (provided below), keep it unless the learner explicitly updated it.
- Merge new facts into "facts" array — short bullet form, only durable things ("loves hiking", "two kids", "studying medicine"), not transient session details.
- "observedErrors" tags should be short, repeatable category labels — they'll be used to prime future sessions to watch for the same mistakes.
- Stay calibrated to the learner's CEFR level. Don't penalize them for missing higher-level structures.
- Return JSON only — no markdown, no commentary, no code fences.`;

export async function summarizeSession(
    transcript: Array<{ role: string; message: string }>,
    language: string = 'de',
    cefr: string = 'a1',
    previousProfile?: LearnerProfile
): Promise<SessionSummaryResult> {
    const client = getBedrockClient();
    const langName = LANG_NAMES[language.toLowerCase()] || 'German';

    const transcriptText = transcript
        .filter(t => t && t.role && t.message)
        .map(t => `${t.role.toUpperCase()}: ${t.message.trim()}`)
        .join('\n');

    const profileBlock = previousProfile
        ? `\nPrevious profile (carry forward unless updated):\n${JSON.stringify(previousProfile, null, 2)}\n`
        : '\nNo previous profile (first session).\n';

    const userMessage = `Target language: ${langName}
Learner CEFR level: ${cefr.toUpperCase()}
${profileBlock}
Conversation transcript:
"""
${transcriptText}
"""

Produce the coaching report and updated profile.`;

    const messages: Message[] = [
        { role: 'user', content: [{ text: userMessage }] },
    ];

    // Prompt caching — same rationale as the analyzer. Summary calls are less frequent but
    // the system prompt is large; first call pays full input, then ~5-min TTL cache hit.
    const commandInput: Record<string, unknown> = {
        modelId: ToolModels.germanAnalysis.modelId,
        messages,
        system: [
            { text: SUMMARY_SYSTEM_PROMPT },
            { cachePoint: { type: 'default' } },
        ],
        inferenceConfig: {
            maxTokens: 2048,
            temperature: 0.2,
        },
    };

    const command = new ConverseCommand(commandInput as any);
    const response = await client.send(command);
    const outputText = response.output?.message?.content?.[0]?.text || '{}';
    const cleaned = outputText.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

    let parsed: SessionSummaryResult;
    try {
        parsed = JSON.parse(cleaned);
    } catch (err) {
        console.error('Failed to parse session summary JSON:', cleaned);
        return {
            summary: 'Summary unavailable.',
            strengths: [],
            weaknesses: [],
            suggestions: [],
            profile: previousProfile || {},
        };
    }

    parsed.strengths = parsed.strengths || [];
    parsed.weaknesses = parsed.weaknesses || [];
    parsed.suggestions = parsed.suggestions || [];
    parsed.profile = parsed.profile || {};
    return parsed;
}
