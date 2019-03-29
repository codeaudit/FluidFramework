import { IPragueResolvedUrl } from "@prague/container-definitions";
import { chooseCelaName, IAlfredTenant } from "@prague/services-core";
import { Router } from "express";
import * as safeStringify from "json-stringify-safe";
import * as jwt from "jsonwebtoken";
import { Provider } from "nconf";
import * as path from "path";
import { parse } from "url";
import * as uuid from "uuid/v4";
import { IAlfred } from "../interfaces";
import { getConfig, getToken, IAlfredUser } from "../utils";
import { defaultPartials } from "./partials";

const defaultTemplate = "pp.txt";
const defaultSpellChecking = "enabled";

// This one is going to need to have references to all storage options

export function create(
    config: Provider,
    alfred: IAlfred,
    appTenants: IAlfredTenant[],
    ensureLoggedIn: any,
): Router {

    const router: Router = Router();

    /**
     * Loads count number of latest commits.
     */
    router.get("/:tenantId?/:id/commits", ensureLoggedIn(), (request, response, next) => {
        const tenantId = request.params.tenantId || appTenants[0].id;

        const versionsP = alfred.getVersions(tenantId, request.params.id, 30);
        versionsP.then(
            (versions) => {
                response.render(
                    "commits",
                    {
                        documentId: request.params.id,
                        partials: defaultPartials,
                        pathPostfix: "commit",
                        tenantId,
                        type: "sharedText",
                        versions: JSON.stringify(versions),
                    });
            },
            (error) => {
                response.status(400).json(safeStringify(error));
            });
    });

    /**
     * Loads task graph for the document.
     */
    router.get("/:tenantId?/:id/taskGraph", ensureLoggedIn(), (request, response, next) => {
        const tenantId = request.params.tenantId || appTenants[0].id;

        const workerConfig = getConfig(
            config.get("worker"),
            tenantId,
            config.get("error:track"));
        const versionP = alfred.getLatestVersion(tenantId, request.params.id);
        const token = getToken(tenantId, request.params.id, appTenants);

        versionP.then((version) => {
            response.render(
                "taskGraph",
                {
                    config: workerConfig,
                    documentId: request.params.id,
                    partials: defaultPartials,
                    tenantId,
                    title: request.params.id,
                    token,
                    version: JSON.stringify(version),
                });
        }, (error) => {
            response.status(400).json(safeStringify(error));
        });
    });

    /**
     * Loading of a specific version of shared text.
     */
    router.get("/:tenantId?/:id/commit", ensureLoggedIn(), async (request, response, next) => {
        const tenantId = request.params.tenantId || appTenants[0].id;

        const disableCache = "disableCache" in request.query;
        const token = getToken(tenantId, request.params.id, appTenants);

        const workerConfig = getConfig(
            config.get("worker"),
            tenantId,
            config.get("error:track"));
        const targetVersionSha = request.query.version;
        const versionP = alfred.getVersion(
            tenantId,
            request.params.id,
            targetVersionSha);

        versionP.then((version) => {
            const pragueUrl = "prague://" +
                `${parse(config.get("worker:serverUrl")).host}/` +
                `${encodeURIComponent(tenantId)}/` +
                `${encodeURIComponent(request.params.id)}` +
                `?version=${version.sha}`;

            const deltaStorageUrl =
                config.get("worker:serverUrl") +
                "/deltas" +
                `/${encodeURIComponent(tenantId)}/${encodeURIComponent(request.params.id)}`;

            const storageUrl =
                config.get("worker:blobStorageUrl").replace("historian:3000", "localhost:3001") +
                "/repos" +
                `/${encodeURIComponent(tenantId)}`;

            const resolved: IPragueResolvedUrl = {
                endpoints: {
                    deltaStorageUrl,
                    ordererUrl: config.get("worker:serverUrl"),
                    storageUrl,
                },
                tokens: { jwt: token },
                type: "prague",
                url: pragueUrl,
            };

            const options = {
                spellchecker: "disabled",
            };
            response.render(
                "sharedText",
                {
                    cache: JSON.stringify(null),
                    config: workerConfig,
                    disableCache,
                    from: Number.NaN,
                    options: JSON.stringify(options),
                    pageInk: request.query.pageInk === "true",
                    partials: defaultPartials,
                    resolved: JSON.stringify(resolved),
                    template: undefined,
                    title: request.params.id,
                    to: Number.NaN,
                    version: JSON.stringify(version),
                });
        }, (error) => {
            response.status(400).json(safeStringify(error));
        });
    });

    router.post("/:tenantId?/:id/fork", ensureLoggedIn(), (request, response, next) => {
        const tenantId = request.params.tenantId || appTenants[0].id;

        const forkP = alfred.createFork(tenantId, request.params.id);
        forkP.then(
            (fork) => {
                response.redirect(`/sharedText/${fork}`);
            },
            (error) => {
                response.status(400).json(safeStringify(error));
            });
    });

    /**
     * Loading of a specific shared text.
     */
    router.get("/:tenantId?/:id", ensureLoggedIn(), async (request, response, next) => {
        const start = Date.now();

        const disableCache = "disableCache" in request.query;

        let celaUser: IAlfredUser = null;
        if ("cela" in request.query) {
            const celaName = chooseCelaName();
            celaUser = { id: uuid(), name: celaName, displayName: celaName };
        }

        const tenantId = request.params.tenantId || appTenants[0].id;
        const token = getToken(tenantId, request.params.id, appTenants, celaUser);

        const from = +request.query.from;
        const to = +request.query.to;

        const jwtToken = jwt.sign(
            {
                user: request.user,
            },
            config.get("gateway:key"));

        const workerConfig = getConfig(
            config.get("worker"),
            tenantId,
            config.get("error:track"));

        const fullTreeP = alfred.getFullTree(tenantId, request.params.id);

        // Track timing
        const treeTimeP = fullTreeP.then(() => Date.now() - start);
        const timingsP = Promise.all([treeTimeP]);

        Promise.all([fullTreeP, timingsP]).then(([fullTree, timings]) => {
            const parsedTemplate = path.parse(request.query.template ? request.query.template : defaultTemplate);
            const template =
                parsedTemplate.base !== "empty" ? `/public/literature/${parsedTemplate.base}` : undefined;

            const parsedSpellchecking =
                path.parse(request.query.spellchecking ? request.query.spellchecking : defaultSpellChecking);
            const spellchecker = parsedSpellchecking.base === "disabled" ? `disabled` : defaultSpellChecking;
            const options = {
                spellchecker,
                translationFromLanguage: "languageFrom" in request.query ? request.query.languageFrom : undefined,
                translationToLanguage: "languageTo" in request.query ? request.query.languageTo : undefined,
            };

            timings.push(Date.now() - start);

            const pragueUrl = "prague://" +
                `${parse(config.get("worker:serverUrl")).host}/` +
                `${encodeURIComponent(tenantId)}/` +
                `${encodeURIComponent(request.params.id)}`;

            const deltaStorageUrl =
                config.get("worker:serverUrl") +
                "/deltas" +
                `/${encodeURIComponent(tenantId)}/${encodeURIComponent(request.params.id)}`;

            const storageUrl =
                config.get("worker:blobStorageUrl").replace("historian:3000", "localhost:3001") +
                "/repos" +
                `/${encodeURIComponent(tenantId)}`;

            const resolved: IPragueResolvedUrl = {
                endpoints: {
                    deltaStorageUrl,
                    ordererUrl: config.get("worker:serverUrl"),
                    storageUrl,
                },
                tokens: { jwt: token },
                type: "prague",
                url: pragueUrl,
            };

            response.render(
                "sharedText",
                {
                    cache: JSON.stringify(fullTree.cache),
                    config: workerConfig,
                    disableCache,
                    from,
                    jwt: jwtToken,
                    options: JSON.stringify(options),
                    pageInk: request.query.pageInk === "true",
                    partials: defaultPartials,
                    resolved: JSON.stringify(resolved),
                    template,
                    timings: JSON.stringify(timings),
                    title: request.params.id,
                    to,
                });
            }, (error) => {
                response.status(400).json(safeStringify(error));
        });
    });

    return router;
}
