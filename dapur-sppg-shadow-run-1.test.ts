import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db } from "@paperclipai/db";

vi.mock("../services/index.js", () => ({ logActivity: vi.fn() }));

function createChainableMock<T>(resolvedValue: T) {
  const chain: Record<string, vi.Mock> = {};
  const handler: Record<string, unknown> = {};

  const methods = ["from", "where", "limit", "innerJoin", "orderBy", "set", "values", "returning"];
  for (const m of methods) {
    const fn = vi.fn().mockReturnValue(handler);
    chain[m] = fn;
  }
  chain.then = vi.fn().mockImplementation((cb: (v: unknown) => unknown) => {
    return Promise.resolve(cb(resolvedValue));
  });

  for (const m of methods) {
    handler[m] = m === "then" ? chain.then : chain[m];
  }
  handler.then = chain.then;

  return handler as unknown as ReturnType<typeof vi.fn>;
}

describe("KMP-283: Shadow Run 1 – Cascading Reroute Loop", () => {
  let svc: ReturnType<typeof import("../services/dapur-sppg.js").dapurSppgService>;
  let mockDb: Db;

  const COMPANY_ID = "00000000-0000-0000-0000-000000000001";
  const FARMER_A_ID = "00000000-0000-0000-0000-000000000020";
  const FARMER_B_ID = "00000000-0000-0000-0000-000000000021";
  const RAW_MATERIAL_CHICKEN_ID = "00000000-0000-0000-0000-000000000010";
  const REGION_SAWOO = "Sawoo";

  beforeEach(async () => {
    vi.resetModules();
    const select = vi.fn();
    const insert = vi.fn();
    const update = vi.fn();
    const execute = vi.fn();
    mockDb = { select, insert, update, execute } as unknown as Db;
    const mod = await import("../services/dapur-sppg.js");
    svc = mod.dapurSppgService(mockDb);
  });

  it("SHADOW RUN 1.1: places order for 65kg Chicken from Farmer A (Sawoo) with PENDING_FARMER_ACCEPT", async () => {
    const executeMock = mockDb.execute as ReturnType<typeof vi.fn>;
    executeMock.mockResolvedValue([]);

    const result = await svc.placeSupplyOrder({
      companyId: COMPANY_ID,
      supplierId: FARMER_A_ID,
      rawMaterialId: RAW_MATERIAL_CHICKEN_ID,
      quantity: 65,
      unit: "kg",
    });

    expect(result.supplierId).toBe(FARMER_A_ID);
    expect(result.rawMaterialId).toBe(RAW_MATERIAL_CHICKEN_ID);
    expect(result.quantity).toBe("65");
    expect(result.unit).toBe("kg");
    expect(result.state).toBe("PENDING_FARMER_ACCEPT");

    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("SHADOW RUN 1.2: simulated SLA timeout triggers processTimeoutEscalations and reroutes to Farmer B", async () => {
    const executeMock = mockDb.execute as ReturnType<typeof vi.fn>;

    const expiredCommitmentRow = {
      id: "expired-commitment-1",
      company_id: COMPANY_ID,
      supplier_id: FARMER_A_ID,
      raw_material_id: RAW_MATERIAL_CHICKEN_ID,
      quantity: "65",
      unit: "kg",
      region: REGION_SAWOO,
    };

    executeMock
      .mockResolvedValueOnce([expiredCommitmentRow])
      .mockResolvedValueOnce([]);

    const backupSupplier = {
      id: FARMER_B_ID,
      companyId: COMPANY_ID,
      rawMaterialId: RAW_MATERIAL_CHICKEN_ID,
      supplierName: "Farmer B",
      region: REGION_SAWOO,
      availableQuantity: "100",
      unit: "kg",
    };

    const selectMock = mockDb.select as ReturnType<typeof vi.fn>;
    selectMock.mockReturnValueOnce(createChainableMock([backupSupplier]));

    executeMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const results = await svc.processTimeoutEscalations();

    expect(results).toHaveLength(1);
    expect(results[0].commitmentId).toBe("expired-commitment-1");
    expect(results[0].previousState).toBe("PENDING_FARMER_ACCEPT");
    expect(results[0].newState).toBe("CASCADING_REROUTE");
    expect(results[0].rerouteSupplierId).toBe(FARMER_B_ID);

    expect(executeMock).toHaveBeenCalledTimes(3);
  });

  it("SHADOW RUN 1.4: findBackupSuppliersInSubdistrict excludes original supplier from same subdistrict", async () => {
    const selectMock = mockDb.select as ReturnType<typeof vi.fn>;

    const backupSupplier = {
      id: FARMER_B_ID,
      companyId: COMPANY_ID,
      rawMaterialId: RAW_MATERIAL_CHICKEN_ID,
      supplierName: "Farmer B",
      region: REGION_SAWOO,
      availableQuantity: "100",
      unit: "kg",
    };
    selectMock.mockReturnValueOnce(createChainableMock([backupSupplier]));

    const results = await svc.findBackupSuppliersInSubdistrict(
      COMPANY_ID,
      RAW_MATERIAL_CHICKEN_ID,
      FARMER_A_ID,
      REGION_SAWOO,
    );

    expect(results).toHaveLength(1);
    expect(results[0].supplierId).toBe(FARMER_B_ID);
    expect(results[0].region).toBe(REGION_SAWOO);
  });

  it("SHADOW RUN 1.5: multiple expired commitments all get processed in one batch", async () => {
    const executeMock = mockDb.execute as ReturnType<typeof vi.fn>;

    const expired1 = {
      id: "expired-commit-1",
      company_id: COMPANY_ID,
      supplier_id: FARMER_A_ID,
      raw_material_id: RAW_MATERIAL_CHICKEN_ID,
      quantity: "65",
      unit: "kg",
      region: REGION_SAWOO,
    };
    const expired2 = {
      id: "expired-commit-2",
      company_id: COMPANY_ID,
      supplier_id: "00000000-0000-0000-0000-000000000030",
      raw_material_id: "00000000-0000-0000-0000-000000000011",
      quantity: "30",
      unit: "kg",
      region: "Bungkal",
    };

    executeMock
      .mockResolvedValueOnce([expired1, expired2])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const selectMock = mockDb.select as ReturnType<typeof vi.fn>;
    selectMock
      .mockReturnValueOnce(createChainableMock([
        {
          id: FARMER_B_ID,
          companyId: COMPANY_ID,
          rawMaterialId: RAW_MATERIAL_CHICKEN_ID,
          supplierName: "Farmer B",
          region: REGION_SAWOO,
          availableQuantity: "100",
          unit: "kg",
        },
      ]))
      .mockReturnValueOnce(createChainableMock([]));

    const results = await svc.processTimeoutEscalations();

    expect(results).toHaveLength(2);

    const firstResult = results.find((r) => r.commitmentId === "expired-commit-1");
    expect(firstResult?.newState).toBe("CASCADING_REROUTE");
    expect(firstResult?.rerouteSupplierId).toBe(FARMER_B_ID);

    const secondResult = results.find((r) => r.commitmentId === "expired-commit-2");
    expect(secondResult?.newState).toBe("TIMEOUT_EXPIRED");
    expect(secondResult?.rerouteSupplierId).toBeUndefined();
  });
});
