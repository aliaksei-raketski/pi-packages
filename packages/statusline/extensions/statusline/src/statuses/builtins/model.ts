import type { StatuslineCollectContext, StatuslineItem, StatuslineProvider } from '../types.ts';

function shouldCollect(requestedKeys: Set<string>): boolean {
  return requestedKeys.size === 0 || requestedKeys.has('model');
}

function collectModelText(model: { id?: string; modelId?: string } | undefined): string {
  if (!model) {
    return 'unknown';
  }

  return typeof model.id === 'string'
    ? model.id
    : typeof model.modelId === 'string'
      ? model.modelId
      : 'unknown';
}

export const modelProvider: StatuslineProvider = {
  keys: ['model'],
  collect(context: StatuslineCollectContext): StatuslineItem[] {
    if (!shouldCollect(context.requestedKeys)) {
      return [];
    }

    return [
      {
        key: 'model',
        text: collectModelText(context.extensionContext.model as { id?: string; modelId?: string }),
      },
    ];
  },
};
