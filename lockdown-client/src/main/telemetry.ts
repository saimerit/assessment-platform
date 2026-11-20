import http from 'node:http'
import https from 'node:https'

interface TelemetryOptions {
    attemptToken: string;
    blueprintId: string;
    studentId: string;
    violationType: string;
    reportedBy?: string;
    evidence?: Record<string, unknown>;
}

export function reportViolation({
    attemptToken,
    blueprintId,
    studentId,
    violationType,
    reportedBy = 'ELECTRON_LOCKDOWN_CLIENT',
    evidence = {}
}: TelemetryOptions): void {
    if (!attemptToken) return
    const apiBase = process.env.ASSESSMENT_API_URL
	if (!apiBase) {
		console.error('[Telemetry] ASSESSMENT_API_URL is not configured; incident was not sent.')
		return
	}
    let endpoint: URL
    try {
        endpoint = new URL(`${apiBase.replace(/\/+$/, '')}/proctor/incidents`)
    } catch {
        console.error('[Telemetry] Invalid ASSESSMENT_API_URL; incident was not sent.')
        return
    }
    const payload = JSON.stringify({
        blueprint_id: blueprintId,
        student_id: studentId,
        violation_type: violationType,
        reported_by: reportedBy,
        evidence_payload: evidence
    });

    const transport = endpoint.protocol === 'https:' ? https : http
    const req = transport.request(
        {
            hostname: endpoint.hostname,
            port: endpoint.port || undefined,
            path: `${endpoint.pathname}${endpoint.search}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${attemptToken}`,
                'Content-Length': Buffer.byteLength(payload)
            }
        },
        (res) => {
            res.resume();
            if (res.statusCode !== 201) {
                console.warn(`[Telemetry] Incident rejected with status ${res.statusCode}`);
            }
        }
    );

    req.on('error', (err) => {
        console.error(`[Telemetry] Failed to dispatch incident: ${err.message}`);
    });
    req.setTimeout(10_000, () => req.destroy(new Error('Incident request timed out')));

    req.write(payload);
    req.end();
}
