import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { serviceErrorCodes } from "../../service/errors.js";
import { serviceRoutes } from "../../service/server.js";

/**
 * Contract test for the published OpenAPI definition: it describes exactly the implemented route
 * set, its failure codes match the service's error vocabulary, and every failure response refers
 * to the shared error schema.
 *
 * See docs/service.md#api.
 */

interface Operation {
  readonly responses: Record<string, unknown>;
}

interface OpenApiSchema {
  readonly type?: string;
  readonly required?: readonly string[];
  readonly properties?: Record<string, unknown>;
  readonly items?: unknown;
}

interface OpenApiDocument {
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string };
  readonly paths: Record<string, Record<string, Operation>>;
  readonly components: {
    readonly responses: Record<string, unknown>;
    readonly schemas: Record<string, OpenApiSchema> & {
      readonly Error: {
        readonly type: string;
        readonly required: readonly string[];
        readonly properties: {
          readonly error: {
            readonly properties: {
              readonly code: { readonly enum: readonly string[] };
            };
          };
        };
      };
    };
  };
}

const readDocument = async (): Promise<OpenApiDocument> =>
  JSON.parse(
    await readFile(
      new URL("../../service/openapi.json", import.meta.url),
      "utf8",
    ),
  ) as OpenApiDocument;

describe("published OpenAPI definition", () => {
  it("describes exactly the implemented route set", async () => {
    const document = await readDocument();
    expect(document.openapi.startsWith("3.1")).toBe(true);
    expect(document.info.title.toLowerCase()).toContain("service");

    const documented = Object.entries(document.paths).flatMap(
      ([path, operations]) =>
        Object.keys(operations).map(
          (method) => `${method.toUpperCase()} ${path}`,
        ),
    );
    const implemented = serviceRoutes.map(
      (route) => `${route.method} ${route.path}`,
    );
    expect(documented.sort()).toEqual(implemented.sort());
  });

  it("declares the documented success and failure responses of each route", async () => {
    const document = await readDocument();
    const observations = document.paths["/v1/observations"]?.post;
    expect(Object.keys(observations?.responses ?? {})).toEqual(
      expect.arrayContaining(["200", "202", "400", "409", "413", "503"]),
    );
    const created = observations?.responses["202"] as {
      headers?: Record<string, unknown>;
    };
    expect(created.headers?.Location).toBeDefined();

    const search = document.paths["/v1/search"]?.post;
    expect(Object.keys(search?.responses ?? {})).toEqual(
      expect.arrayContaining(["200", "400", "429", "503"]),
    );
    const overloaded = search?.responses["429"] as { $ref?: string };
    const overloadedResponse = document.components.responses[
      overloaded.$ref?.replace("#/components/responses/", "") ?? ""
    ] as { headers?: Record<string, unknown> } | undefined;
    expect(overloadedResponse?.headers?.["Retry-After"]).toBeDefined();

    const status = document.paths["/v1/status"]?.get;
    expect(Object.keys(status?.responses ?? {})).toEqual(["200"]);

    // Every failure response names the shared error schema through a component response.
    for (const [path, operations] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        for (const [code, response] of Object.entries(operation.responses)) {
          if (Number(code) < 400) {
            continue;
          }
          const reference = (response as { $ref?: string }).$ref;
          expect(reference, `${method} ${path} ${code}`).toMatch(
            /^#\/components\/responses\//,
          );
        }
      }
    }
  });

  it("documents the same error codes the service classifies by", async () => {
    const document = await readDocument();
    expect(
      document.components.schemas.Error.properties.error.properties.code.enum,
    ).toEqual([...serviceErrorCodes]);
  });

  it("documents receipt enumeration and recovery with the service's evidence", async () => {
    const document = await readDocument();
    const enumeration = document.paths["/v1/receipts"]?.get;
    expect(Object.keys(enumeration?.responses ?? {})).toEqual(
      expect.arrayContaining(["200", "400", "503"]),
    );
    const page = document.components.schemas.ReceiptPage;
    expect(page?.required).toEqual(["receipts"]);
    expect(page?.properties?.receipts).toMatchObject({
      type: "array",
      items: { $ref: "#/components/schemas/Receipt" },
    });

    const recovery = document.paths["/v1/receipts/{receiptId}/recover"]?.post;
    expect(Object.keys(recovery?.responses ?? {})).toEqual(
      expect.arrayContaining(["200", "202", "400", "404", "409", "503"]),
    );
    for (const status of ["200", "202"] as const) {
      const response = recovery?.responses[status] as {
        headers?: Record<string, unknown>;
        content?: {
          "application/json"?: { schema?: { $ref?: string } };
        };
      };
      expect(response.headers?.Location).toBeDefined();
      expect(response.content?.["application/json"]?.schema?.$ref).toBe(
        "#/components/schemas/ReceiptRecovery",
      );
    }
    const conflict = recovery?.responses["409"] as { $ref?: string };
    expect(conflict.$ref).toBe("#/components/responses/RecoveryConflict");
    const request = document.components.schemas.ReceiptRecoveryRequest;
    expect(request?.required).toEqual(["expectedAttemptCount"]);
    const outcome = document.components.schemas.ReceiptRecovery;
    expect(outcome?.required).toEqual(["receipt", "recovered"]);
    // The receipt schema carries the additive recovery evidence the client validates.
    const receipt = document.components.schemas.Receipt;
    expect(receipt?.properties?.recoveries).toMatchObject({
      items: { $ref: "#/components/schemas/ReceiptRecoveryEvidence" },
    });
    const evidence = document.components.schemas.ReceiptRecoveryEvidence;
    expect(evidence?.required).toEqual([
      "requestedAt",
      "attemptCount",
      "lastError",
    ]);
    const queueStatus = document.components.schemas.QueueStatus;
    expect(queueStatus?.properties?.contextCorrection).toMatchObject({
      $ref: "#/components/schemas/ContextCorrection",
    });
  });
});
