import { afterAll, describe, expect, it } from "vitest";
import {
  dropCollection,
  embedded,
  openStore,
  openStoreAt,
  pointCount,
  qdrantUrl,
  uniqueCollection,
} from "../support/note-store.js";
import {
  startControlledProxy,
  type ControlledProxy,
  type InterruptPredicate,
} from "../support/controlled-proxy.js";

/**
 * Provider protocol behavior that a healthy local server cannot demonstrate: request shapes,
 * writes that must not reach Qdrant, and an acknowledgment lost after the write was applied.
 * docs/note-store.md#qdrant-mapping
 */

const created: string[] = [];
const proxies: ControlledProxy[] = [];

const collection = (label: string): string => {
  const name = uniqueCollection(label);
  created.push(name);
  return name;
};

const proxyFor = async (
  interrupt: InterruptPredicate = () => false,
): Promise<ControlledProxy> => {
  const proxy = await startControlledProxy(qdrantUrl(), interrupt);
  proxies.push(proxy);
  return proxy;
};

afterAll(async () => {
  for (const proxy of proxies) {
    await proxy.close();
  }
  for (const name of created) {
    await dropCollection(name);
  }
});

describe("Qdrant note store transport behavior", () => {
  it("does not request anything for empty reads and writes", async () => {
    const proxy = await proxyFor();
    const name = collection("empty");
    const store = await openStoreAt(proxy.url, name);
    await store.put([embedded()]);
    const before = proxy.requests.length;

    expect(await store.get([])).toEqual([]);
    await store.put([]);

    expect(proxy.requests).toHaveLength(before);
  });

  it("requests payloads without vectors and waits for upserts", async () => {
    const proxy = await proxyFor();
    const name = collection("shapes");
    const store = await openStoreAt(proxy.url, name);
    const record = embedded();

    await store.put([record]);
    await store.get([record.note.id]);
    await store.nearest([1, 0, 0, 0], 1);
    await store.page(1);

    const pointRequests = proxy.requests.filter((request) =>
      request.path.includes("/points"),
    );
    const upserts = pointRequests.filter((request) => request.method === "PUT");
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.path).toContain("wait=true");
    expect(upserts[0]?.body).toMatchObject({
      points: [{ id: record.note.id }],
    });
    const reads = pointRequests.filter((request) => request.method === "POST");
    expect(reads.length).toBeGreaterThanOrEqual(3);
    expect(reads.map((read) => read.pathname)).toEqual(
      expect.arrayContaining([
        `/collections/${name}/points`,
        `/collections/${name}/points/query`,
        `/collections/${name}/points/scroll`,
      ]),
    );
    for (const read of reads) {
      expect(read.body).toMatchObject({
        with_payload: true,
        with_vector: false,
      });
    }
    // Normal operations must not list collections or touch retrieval counters.
    expect(
      proxy.requests.filter((request) => request.pathname === "/collections"),
    ).toEqual([]);
    expect(
      pointRequests.filter((request) => request.pathname.includes("/count")),
    ).toEqual([]);
  });

  it("reports an interrupted write acknowledgment instead of success", async () => {
    const name = collection("uncertain");
    let applied = false;
    const interrupted = await proxyFor((request) => {
      if (applied) {
        return false;
      }
      applied =
        request.method === "PUT" &&
        request.pathname === `/collections/${name}/points`;
      return applied;
    });
    const store = await openStoreAt(interrupted.url, name);
    const first = embedded({ content: "The write that loses its reply." });

    await expect(store.put([first])).rejects.toThrow();

    // The server applied the write; only the caller's acknowledgment was lost.
    expect(await pointCount(name)).toBe(1);
    // The same instance continues to work after the failure.
    const second = embedded({ content: "A later write." });
    await store.put([second]);
    expect(await store.get([first.note.id, second.note.id])).toEqual(
      expect.arrayContaining([first.note, second.note]),
    );
  });

  it("revalidates a collection created by a concurrent initializer", async () => {
    const name = collection("race");
    const interrupted = await proxyFor(
      (request) =>
        request.method === "PUT" && request.pathname === `/collections/${name}`,
    );

    const store = await openStoreAt(interrupted.url, name);
    const record = embedded({
      content: "A record from the losing initializer.",
    });
    await store.put([record]);

    expect(await store.get([record.note.id])).toEqual([record.note]);
    const direct = await openStore(name);
    expect((await direct.page(1)).notes).toHaveLength(1);
  });

  it("reports an unreachable server instead of an empty result", async () => {
    const proxy = await proxyFor();
    const name = collection("unreachable");
    const store = await openStoreAt(proxy.url, name);
    const record = embedded({
      content: "Only reachable while the server runs.",
    });
    await store.put([record]);

    await proxy.close();

    await expect(store.get([record.note.id])).rejects.toThrow();
    await expect(store.nearest([1, 0, 0, 0], 1)).rejects.toThrow();
    await expect(store.page(1)).rejects.toThrow();
  });
});
