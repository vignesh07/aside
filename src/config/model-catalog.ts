import { getModels, getProviders } from '@mariozechner/pi-ai';
import type { KnownProvider } from '@mariozechner/pi-ai';

export interface ModelOption {
  provider: string;
  model: string;
  recommended?: boolean;
  label?: string;
}

const PRIORITY_PROVIDERS: ReadonlyArray<KnownProvider> = ['anthropic', 'openai', 'google'];
const RECOMMENDED_HINT_RE = /(nano|mini|haiku|flash-lite|flash|lite|small|fast)/i;

function combinedCost(model: { cost?: { input?: number; output?: number } }): number {
  const input = model.cost?.input ?? Number.POSITIVE_INFINITY;
  const output = model.cost?.output ?? Number.POSITIVE_INFINITY;
  return input + output;
}

function labelFor(model: { id: string; name?: string }): string {
  if (model.name && model.name.trim().length > 0) {
    return `${model.name} (${model.id})`;
  }
  return model.id;
}

function isRecommendedModel(
  model: { id: string; name?: string; cost?: { input?: number; output?: number } },
  rankByCost: number,
): boolean {
  if (rankByCost < 3) return true;
  const text = `${model.name ?? ''} ${model.id}`;
  if (RECOMMENDED_HINT_RE.test(text)) return true;
  // Many proxy/OAuth providers report 0-cost metadata; treat first few as recommended.
  const cost = combinedCost(model);
  return Number.isFinite(cost) && cost <= 2.5;
}

export function flattenModelCatalog(): ModelOption[] {
  const providers = getProviders();
  const sortedProviders: KnownProvider[] = [
    ...PRIORITY_PROVIDERS.filter((p) => providers.includes(p)),
    ...providers.filter((p) => !PRIORITY_PROVIDERS.includes(p)).sort(),
  ];

  const options: ModelOption[] = [];
  for (const provider of sortedProviders) {
    const models = getModels(provider).slice().sort((a, b) => combinedCost(a) - combinedCost(b));
    for (let i = 0; i < models.length; i++) {
      const model = models[i]!;
      options.push({
        provider,
        model: model.id,
        label: labelFor(model),
        recommended: isRecommendedModel(model, i),
      });
    }
  }

  return options;
}

export function findModelOptionIndex(options: ModelOption[], provider: string, model: string): number {
  const idx = options.findIndex((o) => o.provider === provider && o.model === model);
  return idx >= 0 ? idx : 0;
}
