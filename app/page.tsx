import Observatory from '@/components/Observatory';
import { isDemoRequested } from '@/lib/bootstrap';

/**
 * `?demo=1` opens directly in synthetic mode, which is what makes the field impressive
 * even when live Technocore traffic is quiet. The flag only chooses the initial mode;
 * synthetic and live sessions remain strictly separate at runtime.
 *
 * `bootstrapAt` is read once here and passed down so the server render and the client's
 * hydrating render build the identical synthetic session. Letting each side call the clock
 * itself produced two different sessions and a hydration mismatch, which discarded the
 * server tree.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return <Observatory demo={isDemoRequested(params)} bootstrapAt={Date.now()} />;
}
