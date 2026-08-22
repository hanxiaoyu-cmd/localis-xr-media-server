import { MediaPlayer } from '@/app/components/media-player';

export default async function WatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <MediaPlayer mediaId={id} />;
}
