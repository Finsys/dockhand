import { authorize } from '$lib/server/authorize';
import { getDockerConnectionInfo } from "$lib/server/docker";
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params, cookies, url }) => {
    const auth = await authorize(cookies);

    if (auth.authEnabled && !auth.isAuthenticated) {
        return json({ error: "Unauthorized" }, { status: 401 });
    }

    const containerId = params.id;
    const envIdParam = url.searchParams.get("envId");
    const envId = envIdParam ? parseInt(envIdParam, 10) : undefined;

    // Permission check with environment context
    if (!(await auth.can("containers", "attach", envId))) {
        return json({ error: "Permission denied" }, { status: 403 });
    }

    try {
        const connectionInfo = await getDockerConnectionInfo(envId);

        return json({
            containerId,
            connectionInfo: {
                type: connectionInfo.type,
                host: connectionInfo.host,
                port: connectionInfo.port,
            },
        });
    } catch (error) {
        console.error("Error attaching to container:", error);

        return json({ error: "Failed to attach to container" }, { status: 500 });
    }
};
