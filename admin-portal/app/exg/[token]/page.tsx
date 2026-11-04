import ExamGateway from './gateway';

// The token is supplied per request and must not be prerendered as a static route.
export const instant = false;

export default async function ExamGatewayPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <ExamGateway token={token} />;
}
