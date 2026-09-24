import { TToolExtra } from '@/shared/tool/tool.module';

export function resolveCredential(extra: TToolExtra): string | undefined {
  return extra.authInfo?.token;
}
