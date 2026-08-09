import {
  getProviders,
  listConfiguredPiModels,
  listInstalledModels,
} from '../core/providers/index.js';

export interface ModelOption {
  provider: string;
  model: string;
  recommended?: boolean;
  label?: string;
}

interface ConfiguredPiModel {
  provider: string;
  id: string;
  name: string;
}

const PI_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-codex': 'ChatGPT',
  google: 'Google',
  'github-copilot': 'GitHub Copilot',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
  'amazon-bedrock': 'Amazon Bedrock',
  'azure-openai': 'Azure OpenAI',
  'vercel-ai-gateway': 'Vercel AI Gateway',
};

/** Keep Pi's upstream recipient visible instead of presenting Pi as the cloud. */
export function configuredPiModelOptions(
  models: readonly ConfiguredPiModel[],
): ModelOption[] {
  return models.map((model) => ({
    provider: 'pi-cli',
    // Pin both halves. A bare model id could silently resolve to another Pi
    // provider with a model of the same name.
    model: `${model.provider}/${model.id}`,
    label: `${piProviderLabel(model.provider)} · ${model.name}`,
    recommended: true,
  }));
}

function piProviderLabel(provider: string): string {
  const known = PI_PROVIDER_LABELS[provider.toLowerCase()];
  if (known) return known;
  return provider
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || provider;
}

/**
 * Every provider/model the observer can run on, flattened for a picker.
 *
 * Curated rather than exhaustive. A picker listing every model a vendor ever
 * shipped is unusable — and `--model` accepts any id, so this is a shortlist,
 * not a restriction.
 */
export function flattenModelCatalog(): ModelOption[] {
  const options: ModelOption[] = [];
  for (const provider of getProviders()) {
    for (const model of provider.models) {
      options.push({
        provider: provider.id,
        model: model.id,
        label: `${model.label} (${model.id})`,
        ...(model.recommended ? { recommended: true } : {}),
      });
    }
  }
  return options;
}

/**
 * The catalog, plus models discovered from the user's local runtimes.
 *
 * The static Ollama entries are guesses at common models; this reports what the
 * user really pulled. Pi is different: Aside exposes only the exact upstream
 * provider/model Pi reports as configured, rather than dumping Pi's enormous
 * registry into a compact Mac picker. Both lookups are best-effort.
 */
export async function flattenModelCatalogWithLocal(): Promise<ModelOption[]> {
  const base = flattenModelCatalog();
  const [installed, configuredPi] = await Promise.all([
    listInstalledModels(),
    listConfiguredPiModels(),
  ]);

  // Pi has no useful static guess: its configured upstream is the privacy and
  // routing boundary. Real Ollama models replace guesses only when detected.
  const withoutDynamicEntries = base.filter(
    (option) =>
      option.provider !== 'pi-cli' &&
      (installed.length === 0 || option.provider !== 'ollama'),
  );
  return [
    ...withoutDynamicEntries,
    ...configuredPiModelOptions(configuredPi),
    ...installed.map((m, i) => ({
      provider: 'ollama',
      model: m.id,
      label: m.label,
      // Nudge toward the first: it needs no key and keeps transcripts local.
      ...(i === 0 ? { recommended: true } : {}),
    })),
  ];
}

/** Index of provider/model in `options`, or 0 when absent. */
export function findModelOptionIndex(
  options: ModelOption[],
  provider: string,
  model: string,
): number {
  const index = options.findIndex((o) => o.provider === provider && o.model === model);
  return index === -1 ? 0 : index;
}
