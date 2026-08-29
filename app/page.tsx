import Observatory from '@/components/Observatory';

/**
 * `?demo=1` opens directly in synthetic mode, which is what makes the field impressive
 * even when live Technocore traffic is quiet. The flag only chooses the initial mode;
 * synthetic and live sessions remain strictly separate at runtime.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const demo = params.demo === '1' || params.demo === 'true';
  return <Observatory demo={demo} />;
}
