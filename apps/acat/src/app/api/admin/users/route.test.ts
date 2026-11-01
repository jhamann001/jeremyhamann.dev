import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: (...args: unknown[]) => mockAuth(...args),
}));

vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));

const { GET, POST, PATCH, DELETE } = await import("./route");
const { prisma } = await import("@/lib/prisma");

function makeRequest(
  url: string,
  init?: ConstructorParameters<typeof NextRequest>[1]
) {
  return new NextRequest(url, init);
}

const adminSession = {
  user: { email: "admin@example.com", role: "ADMIN" },
};
const userSession = {
  user: { email: "user@example.com", role: "USER" },
};

const mockUser = {
  id: "USR-001",
  email: "alice@example.com",
  name: "Alice",
  role: "USER",
  active: true,
  mcpEnabled: true,
  invitedBy: "admin@example.com",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(adminSession);
});

describe("GET /api/admin/users", () => {
  it("returns all users for admins", async () => {
    (prisma.allowedUser.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([mockUser]);
    const res = await GET();
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data).toHaveLength(1);
    expect(data[0].email).toBe("alice@example.com");
  });

  it("returns 403 for non-admins", async () => {
    mockAuth.mockResolvedValue(userSession);
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("returns 403 for unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(403);
  });
});

describe("POST /api/admin/users", () => {
  it("creates a new user", async () => {
    (prisma.allowedUser.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.allowedUser.create as ReturnType<typeof vi.fn>).mockResolvedValue(mockUser);
    const res = await POST(
      makeRequest("http://localhost/api/admin/users", {
        method: "POST",
        body: JSON.stringify({ email: "alice@example.com", name: "Alice" }),
      })
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.email).toBe("alice@example.com");
  });

  it("returns 409 for duplicate email", async () => {
    (prisma.allowedUser.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockUser);
    const res = await POST(
      makeRequest("http://localhost/api/admin/users", {
        method: "POST",
        body: JSON.stringify({ email: "alice@example.com" }),
      })
    );
    expect(res.status).toBe(409);
  });

  it("rejects non-allowed domains", async () => {
    const res = await POST(
      makeRequest("http://localhost/api/admin/users", {
        method: "POST",
        body: JSON.stringify({ email: "bob@gmail.com" }),
      })
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("example.com");
  });

  it("returns 400 for invalid email", async () => {
    const res = await POST(
      makeRequest("http://localhost/api/admin/users", {
        method: "POST",
        body: JSON.stringify({ email: "not-an-email" }),
      })
    );
    expect(res.status).toBe(400);
  });

  it("returns 403 for non-admins", async () => {
    mockAuth.mockResolvedValue(userSession);
    const res = await POST(
      makeRequest("http://localhost/api/admin/users", {
        method: "POST",
        body: JSON.stringify({ email: "alice@example.com" }),
      })
    );
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/admin/users", () => {
  it("updates user role", async () => {
    (prisma.allowedUser.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockUser);
    (prisma.allowedUser.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockUser,
      role: "ADMIN",
    });
    const res = await PATCH(
      makeRequest("http://localhost/api/admin/users", {
        method: "PATCH",
        body: JSON.stringify({ id: "USR-001", role: "ADMIN" }),
      })
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.role).toBe("ADMIN");
  });

  it("returns 404 for non-existent user", async () => {
    (prisma.allowedUser.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await PATCH(
      makeRequest("http://localhost/api/admin/users", {
        method: "PATCH",
        body: JSON.stringify({ id: "NOPE", role: "ADMIN" }),
      })
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 for missing id", async () => {
    const res = await PATCH(
      makeRequest("http://localhost/api/admin/users", {
        method: "PATCH",
        body: JSON.stringify({ role: "ADMIN" }),
      })
    );
    expect(res.status).toBe(400);
  });

  it.each([
    { role: "ADVISOR" }, { active: false }, { mcpEnabled: false },
  ])("revokes every MCP credential in the user update transaction for %j", async (change) => {
    vi.mocked(prisma.allowedUser.findUnique).mockResolvedValue(mockUser as never);
    vi.mocked(prisma.allowedUser.update).mockResolvedValue({ ...mockUser, ...change } as never);
    const response = await PATCH(makeRequest("http://localhost/api/admin/users", {
      method: "PATCH", body: JSON.stringify({ id: mockUser.id, ...change }),
    }));
    expect(response.status).toBe(200);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function));
    expect(prisma.$queryRaw).toHaveBeenCalledOnce();
    for (const delegate of [prisma.mcpPersonalToken, prisma.mcpConnection]) {
      expect(delegate.updateMany).toHaveBeenCalledWith({
        where: { userEmail: mockUser.email, revokedAt: null }, data: { revokedAt: expect.any(Date) },
      });
    }
    for (const delegate of [prisma.mcpAccessToken, prisma.mcpRefreshToken]) {
      expect(delegate.updateMany).toHaveBeenCalledWith({
        where: { connection: { userEmail: mockUser.email }, revokedAt: null }, data: { revokedAt: expect.any(Date) },
      });
    }
    expect(prisma.mcpOAuthAuthorizationCode.updateMany).toHaveBeenCalledWith({
      where: { userEmail: mockUser.email, consumedAt: null }, data: { consumedAt: expect.any(Date) },
    });
  });

  it("leaves credentials usable for an eligible user's name-only edit", async () => {
    vi.mocked(prisma.allowedUser.findUnique).mockResolvedValue(mockUser as never);
    vi.mocked(prisma.allowedUser.update).mockResolvedValue({ ...mockUser, name: "Updated" } as never);
    expect((await PATCH(makeRequest("http://localhost/api/admin/users", {
      method: "PATCH", body: JSON.stringify({ id: mockUser.id, name: "Updated" }),
    }))).status).toBe(200);
    expect(prisma.mcpPersonalToken.updateMany).not.toHaveBeenCalled();
    expect(prisma.mcpConnection.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    [{ role: "ADVISOR" }, { role: "USER" }],
    [{ active: false }, { active: true }],
    [{ mcpEnabled: false }, { mcpEnabled: true }],
  ])("removing and restoring access never restores the old PAT (%j then %j)", async (remove, restore) => {
    let current = { ...mockUser };
    const pat = { id: "pat-1", userEmail: mockUser.email, scopes: ["acats:read"], revokedAt: null as Date | null };
    (prisma.allowedUser.findUnique as ReturnType<typeof vi.fn>).mockImplementation(async () => current);
    (prisma.allowedUser.update as ReturnType<typeof vi.fn>).mockImplementation(async (args: { data: object }) => {
      current = { ...current, ...(args.data as object) };
      return current;
    });
    (prisma.mcpPersonalToken.updateMany as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      pat.revokedAt ??= new Date();
      return { count: 1 };
    });
    for (const change of [remove, restore]) {
      expect((await PATCH(makeRequest("http://localhost/api/admin/users", {
        method: "PATCH", body: JSON.stringify({ id: mockUser.id, ...change }),
      }))).status).toBe(200);
    }
    expect(current.role).toBe("USER");
    expect(pat.revokedAt).toBeInstanceOf(Date);
    process.env.MCP_ENABLED = "1";
    vi.mocked(prisma.mcpSettings.findUnique).mockResolvedValue({ enabled: true } as never);
    vi.mocked(prisma.mcpPersonalToken.findUnique).mockResolvedValue({ ...pat, user: current } as never);
    const { validateMcpBearerToken } = await import("@/lib/mcp/access-token");
    await expect(validateMcpBearerToken("Bearer mcp_pat_existing")).rejects.toThrow("Invalid bearer token");
  });
});

describe("DELETE /api/admin/users", () => {
  it("deactivates a user", async () => {
    (prisma.allowedUser.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockUser);
    (prisma.allowedUser.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockUser,
      active: false,
    });
    const res = await DELETE(
      makeRequest("http://localhost/api/admin/users?id=USR-001", {
        method: "DELETE",
      })
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.active).toBe(false);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function));
    expect(prisma.mcpPersonalToken.updateMany).toHaveBeenCalled();
    expect(prisma.mcpConnection.updateMany).toHaveBeenCalled();
    expect(prisma.mcpOAuthAuthorizationCode.updateMany).toHaveBeenCalled();
  });

  it("prevents self-deactivation", async () => {
    (prisma.allowedUser.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockUser,
      email: "admin@example.com",
    });
    const res = await DELETE(
      makeRequest("http://localhost/api/admin/users?id=USR-001", {
        method: "DELETE",
      })
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("own account");
  });

  it("returns 400 if no id provided", async () => {
    const res = await DELETE(
      makeRequest("http://localhost/api/admin/users", {
        method: "DELETE",
      })
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 for non-existent user", async () => {
    (prisma.allowedUser.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await DELETE(
      makeRequest("http://localhost/api/admin/users?id=NOPE", {
        method: "DELETE",
      })
    );
    expect(res.status).toBe(404);
  });
});

describe("persona fence (PERSONA_SIGN_IN=on)", () => {
  const persona = { ...mockUser, id: "USR-PERSONA", email: "jordan.reyes@example.com", name: "Jordan Reyes" };
  const patch = (body: object) =>
    PATCH(makeRequest("http://localhost/api/admin/users", { method: "PATCH", body: JSON.stringify(body) }));

  beforeEach(() => vi.stubEnv("PERSONA_SIGN_IN", "on"));
  afterEach(() => vi.unstubAllEnvs());

  it.each([{ role: "ADMIN" }, { active: false }, { name: "Someone Else" }, { mcpEnabled: false }])(
    "refuses %j on a persona and changes nothing",
    async (change) => {
      vi.mocked(prisma.allowedUser.findUnique).mockResolvedValue(persona as never);
      const res = await patch({ id: persona.id, ...change });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Demo sign-in accounts can't be changed." });
      expect(prisma.allowedUser.update).not.toHaveBeenCalled();
    },
  );

  it("fences a persona account whatever the letter case of its stored email", async () => {
    vi.mocked(prisma.allowedUser.findUnique).mockResolvedValue({ ...persona, email: "Jordan.Reyes@Example.com" } as never);
    expect((await patch({ id: persona.id, role: "ADMIN" })).status).toBe(403);
    expect(prisma.allowedUser.update).not.toHaveBeenCalled();
  });

  it("checks the row the id resolves to: an id in another case finds no user and changes nothing", async () => {
    // Postgres compares the cuid exactly, as the update would; the fence never sees a different row.
    vi.mocked(prisma.allowedUser.findUnique).mockResolvedValue(null);
    expect((await patch({ id: persona.id.toLowerCase(), role: "ADMIN" })).status).toBe(404);
    expect(prisma.allowedUser.findUnique).toHaveBeenCalledWith({ where: { id: "usr-persona" } });
    expect(prisma.allowedUser.update).not.toHaveBeenCalled();
  });

  it("refuses to deactivate a persona", async () => {
    vi.mocked(prisma.allowedUser.findUnique).mockResolvedValue(persona as never);
    const res = await DELETE(makeRequest(`http://localhost/api/admin/users?id=${persona.id}`, { method: "DELETE" }));
    expect(res.status).toBe(403);
    expect(prisma.allowedUser.update).not.toHaveBeenCalled();
  });

  it("leaves other staff editable", async () => {
    vi.mocked(prisma.allowedUser.findUnique).mockResolvedValue(mockUser as never);
    vi.mocked(prisma.allowedUser.update).mockResolvedValue({ ...mockUser, role: "ADMIN" } as never);
    expect((await patch({ id: mockUser.id, role: "ADMIN" })).status).toBe(200);
  });

  it("does not apply outside the demo", async () => {
    vi.stubEnv("PERSONA_SIGN_IN", "");
    vi.mocked(prisma.allowedUser.findUnique).mockResolvedValue(persona as never);
    vi.mocked(prisma.allowedUser.update).mockResolvedValue({ ...persona, role: "ADMIN" } as never);
    expect((await patch({ id: persona.id, role: "ADMIN" })).status).toBe(200);
  });
});

describe("MCP access in the demo (NEXT_PUBLIC_DEMO_MODE=on)", () => {
  const patch = (body: object) =>
    PATCH(makeRequest("http://localhost/api/admin/users", { method: "PATCH", body: JSON.stringify(body) }));

  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "on"));
  afterEach(() => vi.unstubAllEnvs());

  it("refuses to turn MCP access on for anyone, since the demo runs no MCP server", async () => {
    vi.mocked(prisma.allowedUser.findUnique).mockResolvedValue(mockUser as never);
    const res = await patch({ id: mockUser.id, mcpEnabled: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Claude MCP is off in this demo." });
    expect(prisma.allowedUser.update).not.toHaveBeenCalled();
  });

  it("still allows other edits", async () => {
    vi.mocked(prisma.allowedUser.findUnique).mockResolvedValue(mockUser as never);
    vi.mocked(prisma.allowedUser.update).mockResolvedValue({ ...mockUser, role: "ADMIN" } as never);
    expect((await patch({ id: mockUser.id, role: "ADMIN" })).status).toBe(200);
  });
});

describe("POST /api/admin/users in the public demo", () => {
  beforeEach(() => vi.stubEnv("PERSONA_SIGN_IN", "on"));
  afterEach(() => vi.unstubAllEnvs());

  it("refuses a new user once the demo holds its cap", async () => {
    vi.mocked(prisma.allowedUser.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.allowedUser.count).mockResolvedValue(30);
    const res = await POST(
      makeRequest("http://localhost/api/admin/users", {
        method: "POST",
        body: JSON.stringify({ email: "alice@example.com", name: "Alice" }),
      })
    );
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/^The demo holds up to 30 users/);
    expect(prisma.allowedUser.create).not.toHaveBeenCalled();
  });
});
