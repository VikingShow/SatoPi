/**
 * Role Asset Library — YAML-based role definitions for SatoPi workers.
 *
 * Each role is a standalone .role.yaml file at `.swarm-workspace/roles/{role-id}.role.yaml`.
 * Roles define system prompts, tool permissions, metadata, and approval lifecycle.
 *
 * Lifecycle: draft → proposed → approved → deprecated
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";

// ============================================================================
// Types
// ============================================================================

export type RoleStatus = "draft" | "proposed" | "approved" | "deprecated";

export interface RoleAsset {
  id: string;
  name: string;
  description: string;
  version: number;
  author: string;
  status: RoleStatus;
  /** P0-C: Role pool — "workers" for execution roles, "cloners" for review roles. */
  pool: "workers" | "cloners";
  prompts: {
    system: string;
    guidelines: string[];
  };
  tools: string[];
  tags: string[];
  created_at: string;
  updated_at: string;
  usage_count: number;
  success_rate: number;
  /** P0-C: Cloner-specific fields. */
  veto?: boolean;
  weight?: number;
  /** Named skills to load and inject into the agent's system prompt. */
  skills?: string[];
  /** MCP server names whose tools are available to agents using this role. */
  mcp_servers?: string[];
  /** Per-role model override (e.g. "deepseek-v4-pro" or "claude-sonnet-4-20250514"). */
  model?: string;
}

export interface RoleAssetSummary {
  id: string;
  name: string;
  description: string;
  status: RoleStatus;
  pool: "workers" | "cloners";
  version: number;
  tags: string[];
  usage_count: number;
  success_rate: number;
  updated_at: string;
}

export interface RoleSearchParams {
  tag?: string;
  status?: RoleStatus;
  q?: string;
}

export interface RoleUpdateInput {
  name?: string;
  description?: string;
  prompts?: {
    system?: string;
    guidelines?: string[];
  };
  tools?: string[];
  tags?: string[];
  skills?: string[];
  mcp_servers?: string[];
  model?: string;
}

export interface RoleCreateInput {
  id: string;
  name: string;
  description: string;
  author?: string;
  pool?: "workers" | "cloners";
  prompts: {
    system: string;
    guidelines: string[];
  };
  tools: string[];
  tags: string[];
  skills?: string[];
  mcp_servers?: string[];
  model?: string;
  veto?: boolean;
  weight?: number;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_ROLES_DIR = "roles";

// ============================================================================
// RoleAssetManager
// ============================================================================

export class RoleAssetManager {
  readonly #rolesDir: string;

  constructor(workspaceDir: string) {
    this.#rolesDir = path.join(workspaceDir, DEFAULT_ROLES_DIR);
  }

  /** Ensure the roles directory exists. */
  async init(): Promise<void> {
    await fs.mkdir(this.#rolesDir, { recursive: true });
  }

  get rolesDir(): string {
    return this.#rolesDir;
  }

  // ========================================================================
  // Read
  // ========================================================================

  /** Get a single role by ID. Returns null if not found. */
  async get(id: string): Promise<RoleAsset | null> {
    const filePath = this.#rolePath(id);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      return Bun.YAML.parse(content) as RoleAsset;
    } catch {
      return null;
    }
  }

  /** List all roles, optionally filtered by status. */
  async list(statusFilter?: RoleStatus): Promise<RoleAssetSummary[]> {
    await this.init();

    let entries: string[];
    try {
      entries = await fs.readdir(this.#rolesDir);
    } catch {
      return [];
    }

    const roles: RoleAssetSummary[] = [];

    for (const name of entries) {
      if (!name.endsWith(".role.yaml")) continue;

      try {
        const content = await fs.readFile(
          path.join(this.#rolesDir, name),
          "utf-8",
        );
        const role = Bun.YAML.parse(content) as RoleAsset;
        if (statusFilter && role.status !== statusFilter) continue;

        roles.push({
          id: role.id,
          name: role.name,
          description: role.description,
          status: role.status,
          pool: role.pool ?? "workers",
          version: role.version,
          tags: role.tags,
          usage_count: role.usage_count,
          success_rate: role.success_rate,
          updated_at: role.updated_at,
        });
      } catch {
        // Skip invalid files
      }
    }

    return roles;
  }

  /** P0-C: List roles filtered by pool ("workers" | "cloners"). */
  async listByPool(pool: "workers" | "cloners"): Promise<RoleAssetSummary[]> {
    const all = await this.list();
    return all.filter(r => r.pool === pool);
  }

  /** Search roles by tag, status, and/or text query. */
  async search(params: RoleSearchParams): Promise<RoleAssetSummary[]> {
    const all = await this.list();

    return all.filter((r) => {
      if (params.status && r.status !== params.status) return false;
      if (params.tag) {
        const searchTag = params.tag.toLowerCase();
        if (!r.tags.some((t) => t.toLowerCase() === searchTag)) return false;
      }
      if (params.q) {
        const q = params.q.toLowerCase();
        const haystack = `${r.name} ${r.description} ${r.tags.join(" ")}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }

  // ========================================================================
  // Write
  // ========================================================================

  /** Create a new role (goes to draft status). */
  async create(input: RoleCreateInput): Promise<RoleAsset> {
    await this.init();

    const filePath = this.#rolePath(input.id);
    try {
      await fs.access(filePath);
      throw new Error(`Role "${input.id}" already exists`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Role ")) throw err;
      // File doesn't exist — proceed
    }

    const now = new Date().toISOString();
    const role: RoleAsset = {
      id: input.id,
      name: input.name,
      description: input.description,
      version: 1,
      author: input.author ?? "human",
      status: "draft",
      pool: input.pool ?? "workers",
      prompts: {
        system: input.prompts.system,
        guidelines: input.prompts.guidelines,
      },
      tools: input.tools,
      tags: input.tags,
      skills: input.skills,
      mcp_servers: input.mcp_servers,
      model: input.model,
      created_at: now,
      updated_at: now,
      usage_count: 0,
      success_rate: 1.0,
      veto: input.veto,
      weight: input.weight,
    };

    const yaml = serializeRoleYaml(role);
    await fs.writeFile(filePath, yaml, "utf-8");
    return role;
  }

  /** Update an existing role (proposes changes — bumps version, sets proposed). */
  async update(id: string, input: RoleUpdateInput): Promise<RoleAsset> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Role "${id}" not found`);

    const now = new Date().toISOString();
    const updated: RoleAsset = {
      ...existing,
      name: input.name ?? existing.name,
      description: input.description ?? existing.description,
      version: existing.version + 1,
      status: "proposed",
      prompts: {
        system: input.prompts?.system ?? existing.prompts.system,
        guidelines: input.prompts?.guidelines ?? existing.prompts.guidelines,
      },
      tools: input.tools ?? existing.tools,
      tags: input.tags ?? existing.tags,
      skills: input.skills !== undefined ? input.skills : existing.skills,
      mcp_servers: input.mcp_servers !== undefined ? input.mcp_servers : existing.mcp_servers,
      model: input.model !== undefined ? input.model : existing.model,
      updated_at: now,
    };

    const yaml = serializeRoleYaml(updated);
    await fs.writeFile(this.#rolePath(id), yaml, "utf-8");
    return updated;
  }

  /** Approve a proposed role — changes status to approved. */
  async approve(id: string): Promise<RoleAsset> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Role "${id}" not found`);
    if (existing.status !== "proposed" && existing.status !== "draft") {
      throw new Error(`Cannot approve role with status "${existing.status}"`);
    }

    const updated: RoleAsset = {
      ...existing,
      status: "approved",
      updated_at: new Date().toISOString(),
    };

    const yaml = serializeRoleYaml(updated);
    await fs.writeFile(this.#rolePath(id), yaml, "utf-8");
    return updated;
  }

  /** Deprecate a role — changes status to deprecated. */
  async deprecate(id: string): Promise<RoleAsset> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Role "${id}" not found`);

    const updated: RoleAsset = {
      ...existing,
      status: "deprecated",
      updated_at: new Date().toISOString(),
    };

    const yaml = serializeRoleYaml(updated);
    await fs.writeFile(this.#rolePath(id), yaml, "utf-8");
    return updated;
  }

  /** Increment usage count for a role. */
  async recordUsage(id: string, success: boolean): Promise<void> {
    const existing = await this.get(id);
    if (!existing) return;

    const n = existing.usage_count;
    const updated: RoleAsset = {
      ...existing,
      usage_count: n + 1,
      success_rate: (existing.success_rate * n + (success ? 1 : 0)) / (n + 1),
      updated_at: new Date().toISOString(),
    };

    const yaml = serializeRoleYaml(updated);
    await fs.writeFile(this.#rolePath(id), yaml, "utf-8");
  }

  /** Delete a role file entirely. */
  async delete(id: string): Promise<boolean> {
    const filePath = this.#rolePath(id);
    try {
      await fs.unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }

  // ========================================================================
  // Seed data
  // ========================================================================

  /** Seed the roles directory with built-in role assets if it's empty. */
  async seedIfEmpty(): Promise<number> {
    await this.init();

    let entries: string[];
    try {
      entries = await fs.readdir(this.#rolesDir);
    } catch {
      entries = [];
    }

    const existingRoles = entries.filter(
      (e) => e.endsWith(".role.yaml"),
    );

    if (existingRoles.length > 0) return 0; // Already seeded

    const seeds = getBuiltInRoles();
    let count = 0;

    for (const seed of seeds) {
      try {
        await this.create(seed);
        await this.approve(seed.id);
        count++;
      } catch {
        // Skip if already exists
      }
    }

    return count;
  }

  // ========================================================================
  // Internal
  // ========================================================================

  #rolePath(id: string): string {
    // Sanitize ID: allow only alphanumeric, hyphens, underscores
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.#rolesDir, `${safe}.role.yaml`);
  }
}

// ============================================================================
// YAML serialization / deserialization
// ============================================================================

/** Serialize a RoleAsset back to YAML string. */
function serializeRoleYaml(role: RoleAsset): string {
  const lines: string[] = [
    `id: "${role.id}"`,
    `name: "${role.name}"`,
    `description: "${role.description}"`,
    `version: ${role.version}`,
    `author: "${role.author}"`,
    `status: "${role.status}"`,
    "prompts:",
    `  system: |`,
    ...role.prompts.system.split("\n").map((l) => `    ${l}`),
    "  guidelines:",
    ...role.prompts.guidelines.map((g) => `    - "${g}"`),
    "tools:",
    ...role.tools.map((t) => `  - "${t}"`),
    "tags:",
    ...role.tags.map((t) => `  - "${t}"`),
  ];

  if (role.skills && role.skills.length > 0) {
    lines.push("skills:");
    role.skills.forEach((s) => lines.push(`  - "${s}"`));
  }
  if (role.mcp_servers && role.mcp_servers.length > 0) {
    lines.push("mcp_servers:");
    role.mcp_servers.forEach((m) => lines.push(`  - "${m}"`));
  }
  if (role.model) {
    lines.push(`model: "${role.model}"`);
  }

  lines.push(
    `created_at: "${role.created_at}"`,
    `updated_at: "${role.updated_at}"`,
    `usage_count: ${role.usage_count}`,
    `success_rate: ${role.success_rate}`,
  );

  return lines.join("\n") + "\n";
}

// ============================================================================
// Built-in role definitions
// ============================================================================

export function getBuiltInRoles(): RoleCreateInput[] {
  return [
    {
      id: "architect",
      name: "System Architect",
      description:
        "Designs high-level architecture, makes strategic technical decisions, and ensures system coherence across components.",
      author: "swarm",
      prompts: {
        system:
          "You are a System Architect on a SatoPi swarm team. Your role is to design the high-level architecture, make strategic technical decisions, and ensure all components fit together coherently.\n\n" +
          "Guidelines:\n" +
          "- Think in terms of system design: modules, interfaces, data flows, and trade-offs\n" +
          "- Consider scalability, maintainability, and technical debt implications\n" +
          "- Provide clear architectural reasoning for your decisions\n" +
          "- Identify risks and propose mitigation strategies\n" +
          "- Coordinate with backend and frontend developers to ensure alignment\n" +
          "- Document architectural decisions for future reference",
        guidelines: [
          "Design high-level system architecture",
          "Make strategic technical decisions",
          "Identify architectural risks and trade-offs",
          "Ensure cross-component coherence",
          "Document architectural decisions (ADRs)",
        ],
      },
      tools: [
        "read_file",
        "search_file",
        "search_content",
        "write_to_file",
        "list_dir",
      ],
      tags: ["architecture", "design", "system", "planning"],
      pool: "workers",
    },
    {
      id: "backend-dev",
      name: "Backend Developer",
      description:
        "Expert in Node.js, Bun, TypeScript backend development. Writes APIs, database queries, and server-side logic.",
      author: "swarm",
      prompts: {
        system:
          "You are a Backend Developer on a SatoPi swarm team. You specialize in Node.js, Bun, and TypeScript backend development.\n\n" +
          "Guidelines:\n" +
          "- Write clean, type-safe TypeScript code\n" +
          "- Design RESTful APIs with proper error handling\n" +
          "- Write efficient database queries\n" +
          "- Implement proper validation and authentication\n" +
          "- Write comprehensive tests for your code\n" +
          "- Consider performance and security implications",
        guidelines: [
          "Write type-safe TypeScript backend code",
          "Design RESTful API endpoints",
          "Implement database queries and migrations",
          "Add proper validation and error handling",
          "Write unit and integration tests",
        ],
      },
      tools: [
        "read_file",
        "write_to_file",
        "execute_command",
        "search_content",
        "search_file",
        "list_dir",
      ],
      tags: ["backend", "typescript", "api", "database", "nodejs"],
      pool: "workers",
    },
    {
      id: "frontend-dev",
      name: "Frontend Developer",
      description:
        "Builds modern user interfaces with React, TypeScript, and CSS. Focuses on UX, accessibility, and component design.",
      author: "swarm",
      prompts: {
        system:
          "You are a Frontend Developer on a SatoPi swarm team. You build modern, responsive user interfaces using React, TypeScript, and CSS.\n\n" +
          "Guidelines:\n" +
          "- Build accessible, responsive UI components\n" +
          "- Use React with TypeScript for type safety\n" +
          "- Follow modern CSS practices (Tailwind, CSS modules)\n" +
          "- Optimize for performance and bundle size\n" +
          "- Ensure cross-browser compatibility\n" +
          "- Write component tests and stories",
        guidelines: [
          "Build React components with TypeScript",
          "Ensure accessibility (a11y) compliance",
          "Implement responsive design",
          "Optimize rendering performance",
          "Write component unit tests",
        ],
      },
      tools: [
        "read_file",
        "write_to_file",
        "search_content",
        "search_file",
        "list_dir",
      ],
      tags: ["frontend", "react", "typescript", "ui", "css"],
      pool: "workers",
    },
    {
      id: "code-reviewer",
      name: "Code Reviewer",
      description:
        "Reviews code for quality, best practices, security issues, and adherence to standards. Provides constructive feedback.",
      author: "swarm",
      prompts: {
        system:
          "You are a Code Reviewer on a SatoPi swarm team. Your role is to review code for quality, correctness, security, and adherence to best practices.\n\n" +
          "Guidelines:\n" +
          "- Review code for correctness, readability, and maintainability\n" +
          "- Check for security vulnerabilities (OWASP Top 10)\n" +
          "- Verify adherence to coding standards and conventions\n" +
          "- Look for potential bugs, edge cases, and race conditions\n" +
          "- Provide constructive, specific feedback with suggestions\n" +
          "- Balance thoroughness with pragmatism — don't block on minor style issues",
        guidelines: [
          "Review code for correctness and quality",
          "Check for security vulnerabilities",
          "Verify coding standards compliance",
          "Identify edge cases and potential bugs",
          "Provide constructive, actionable feedback",
        ],
      },
      tools: [
        "read_file",
        "search_content",
        "search_file",
        "list_dir",
      ],
      tags: ["review", "quality", "security", "code-review"],
      pool: "workers",
    },
    {
      id: "devops-engineer",
      name: "DevOps Engineer",
      description:
        "Manages deployment, CI/CD pipelines, infrastructure configuration, and operational concerns.",
      author: "swarm",
      prompts: {
        system:
          "You are a DevOps Engineer on a SatoPi swarm team. You handle deployment, CI/CD, infrastructure, and operational concerns.\n\n" +
          "Guidelines:\n" +
          "- Design and maintain CI/CD pipelines\n" +
          "- Manage Docker configurations and containerization\n" +
          "- Configure monitoring, logging, and alerting\n" +
          "- Ensure infrastructure as code (IaC) practices\n" +
          "- Handle environment configuration and secrets management\n" +
          "- Plan for scalability and disaster recovery",
        guidelines: [
          "Design CI/CD pipelines",
          "Manage Docker and container configurations",
          "Set up monitoring and alerting",
          "Practice infrastructure as code",
          "Handle deployment automation",
        ],
      },
      tools: [
        "read_file",
        "write_to_file",
        "execute_command",
        "search_content",
        "search_file",
        "list_dir",
      ],
      pool: "workers",
      tags: ["devops", "ci-cd", "docker", "infrastructure", "deployment"],
    },

    // ── P0-C: Cloner review roles ──────────────────────────────────────

    {
      id: "cloner-guardian",
      name: "Guardian Reviewer",
      description: "Reviews worker output against the plan for alignment, quality, safety, and completeness.",
      author: "swarm",
      pool: "cloners",
      prompts: {
        system:
          "You are a Guardian Reviewer in the SatoPi swarm system.\n" +
          "Your role is to review worker output against the plan's goals, constraints, and acceptance criteria.\n\n" +
          "REVIEW DIMENSIONS:\n" +
          "- Alignment: Does the output match what the plan asked for?\n" +
          "- Quality: Is the code well-structured, tested, and maintainable?\n" +
          "- Safety: Are there obvious security risks or data loss concerns?\n" +
          "- Completeness: Are all plan requirements addressed?\n\n" +
          "Inspect the actual workspace files — do not rely solely on worker summaries.\n" +
          "Output ONLY a JSON verdict line.",
        guidelines: [
          "Check output against plan acceptance criteria",
          "Verify files exist and match claims",
          "Assess code quality and structure",
          "Flag incomplete or incorrect work",
          "Review README and documentation changes",
        ],
      },
      tools: ["read", "grep", "glob"],
      tags: ["cloner", "guardian", "review"],
      weight: 1.0,
    },
    {
      id: "cloner-adversarial",
      name: "Adversarial Reviewer",
      description: "Actively tries to find bugs, edge cases, and security vulnerabilities in worker output.",
      author: "swarm",
      pool: "cloners",
      veto: true,
      prompts: {
        system:
          "You are an Adversarial Reviewer in the SatoPi swarm system.\n" +
          "Your job is to find ways the worker output FAILS — even if it looks correct on the surface.\n\n" +
          "CRITICAL APPROACH:\n" +
          "- Assume every claim in the output could be wrong until verified in the actual files\n" +
          "- Look for: silent data loss, race conditions, missing error handling,\n" +
          "  security vulnerabilities (OWASP Top 10), broken edge cases, API contract violations\n" +
          "- If a worker claims 'completed X' but the file does not exist or is incomplete → FAIL\n" +
          "- Be suspicious of: hand-wavy descriptions, untested code paths,\n" +
          "  hardcoded credentials, missing input validation\n" +
          "- Prefer FALSE NEGATIVES over FALSE POSITIVES\n\n" +
          "Output ONLY a JSON verdict line.",
        guidelines: [
          "Try to BREAK the output — hunt for bugs and edge cases",
          "Check for OWASP Top 10 vulnerabilities",
          "Look for missing error handling and input validation",
          "Verify that claimed features actually work",
          "Challenge every assumption in the worker output",
        ],
      },
      tools: ["read", "grep", "glob", "bash"],
      tags: ["cloner", "adversarial", "security", "bug-hunting"],
      weight: 1.5,
    },
    {
      id: "cloner-security",
      name: "Security Reviewer",
      description: "Focused security audit: OWASP, injection, authentication, data leaks, cryptography.",
      author: "swarm",
      pool: "cloners",
      veto: true,
      prompts: {
        system:
          "You are a Security Reviewer in the SatoPi swarm system.\n" +
          "Your sole focus is security — you audit worker output for vulnerabilities.\n\n" +
          "CHECKLIST:\n" +
          "- OWASP Top 10: injection, broken auth, sensitive data exposure, XXE,\n" +
          "  broken access control, security misconfiguration, XSS, insecure deserialization,\n" +
          "  using components with known vulnerabilities, insufficient logging\n" +
          "- Authentication: password hashing, session management, JWT safety\n" +
          "- Authorization: access control, RBAC, privilege boundaries\n" +
          "- Data: encryption at rest/in transit, PII handling, SQL injection\n" +
          "- Secrets: no hardcoded keys, proper .env usage, gitignore for secrets\n\n" +
          "Any security vulnerability → automatic FAIL with veto power.\n" +
          "Output ONLY a JSON verdict line.",
        guidelines: [
          "Audit for OWASP Top 10 vulnerabilities",
          "Check authentication and authorization logic",
          "Inspect data handling and encryption",
          "Look for hardcoded secrets or keys",
          "Review dependency security",
        ],
      },
      tools: ["read", "grep", "glob"],
      tags: ["cloner", "security", "owasp", "audit"],
      weight: 2.0,
    },
    {
      id: "cloner-performance",
      name: "Performance Reviewer",
      description: "Reviews output for performance issues: algorithmic complexity, N+1 queries, resource usage.",
      author: "swarm",
      pool: "cloners",
      prompts: {
        system:
          "You are a Performance Reviewer in the SatoPi swarm system.\n" +
          "You review worker output for efficiency, scalability, and resource usage.\n\n" +
          "CHECKLIST:\n" +
          "- Algorithmic complexity: any O(n²) or worse when O(n) or O(n log n) exists?\n" +
          "- Database: N+1 queries, missing indexes, inefficient joins\n" +
          "- Memory: potential leaks, large allocations, unbounded collections\n" +
          "- I/O: unnecessary file reads, blocking operations in async contexts\n" +
          "- Network: excessive API calls, missing caching, large payloads\n\n" +
          "Output ONLY a JSON verdict line.",
        guidelines: [
          "Check algorithmic complexity",
          "Look for N+1 database queries",
          "Identify memory leaks or excessive allocation",
          "Review I/O patterns and caching",
          "Flag inefficient API call patterns",
        ],
      },
      tools: ["read", "grep", "glob", "bash"],
      tags: ["cloner", "performance", "optimization"],
      weight: 0.8,
    },
    {
      id: "cloner-architecture",
      name: "Architecture Reviewer",
      description: "Reviews output for structural integrity: API contracts, module boundaries, dependency direction.",
      author: "swarm",
      pool: "cloners",
      prompts: {
        system:
          "You are an Architecture Reviewer in the SatoPi swarm system.\n" +
          "You review worker output for structural integrity and design consistency.\n\n" +
          "CHECKLIST:\n" +
          "- API contracts: are interfaces consistent? Breaking changes?\n" +
          "- Module boundaries: proper separation of concerns?\n" +
          "- Dependency direction: does it follow the dependency inversion principle?\n" +
          "- Data flow: is data flowing in the right direction? No circular deps?\n" +
          "- Error handling strategy: consistent across modules?\n" +
          "- Test architecture: are tests at the right level (unit/integration/e2e)?\n\n" +
          "Output ONLY a JSON verdict line.",
        guidelines: [
          "Check API contract consistency",
          "Verify module boundary integrity",
          "Review dependency direction",
          "Assess error handling strategy",
          "Evaluate test architecture",
        ],
      },
      tools: ["read", "grep", "glob"],
      tags: ["cloner", "architecture", "design", "structure"],
      weight: 1.0,
    },

    // ── Script & Curtain phase roles ────────────────────────────────────

    {
      id: "planner",
      name: "Planner",
      description:
        "Facilitates planning sessions during the Script phase. Engages in Socratic dialogue with the user to clarify goals, constraints, and acceptance criteria, then produces a detailed plan.md.",
      author: "swarm",
      pool: "workers",
      prompts: {
        system:
          "You are a Planner agent in the SatoPi system. Your role is to help the user clarify their goals and produce a comprehensive, executable plan.\n\n" +
          "GUIDELINES:\n" +
          "- Ask probing questions to understand the full scope of the task\n" +
          "- Challenge assumptions gently — surface hidden constraints\n" +
          "- Break down complex goals into concrete deliverables\n" +
          "- Define clear acceptance criteria for each deliverable\n" +
          "- Propose an appropriate agent-hour estimate and team composition\n" +
          "- Write the final plan to plan.md when you have sufficient clarity\n" +
          "- Be concise but thorough — quality over quantity",
        guidelines: [
          "Clarify goals through Socratic dialogue",
          "Produce structured plan.md with todo-tasks",
          "Estimate agent-hours required",
          "Recommend agent count and composition",
          "Define acceptance criteria for each deliverable",
        ],
      },
      tools: ["read", "write", "grep", "find", "glob"],
      tags: ["planning", "script", "analysis", "facilitation"],
    },
    {
      id: "reporter",
      name: "Reporter",
      description:
        "Reports build results to the user during the Curtain phase. Summarizes what was built, files changed, test results, and any known issues.",
      author: "swarm",
      pool: "workers",
      prompts: {
        system:
          "You are a Reporter agent in the SatoPi system. Your role is to present the results of a completed build phase to the user clearly and concisely.\n\n" +
          "GUIDELINES:\n" +
          "- Read the actual workspace files to verify claims\n" +
          "- Summarize what was built and why\n" +
          "- List key files changed and their purpose\n" +
          "- Report test results (pass/fail counts, coverage)\n" +
          "- Flag any known issues or incomplete work honestly\n" +
          "- Structure the report for quick scanning (sections, bullet points)\n" +
          "- Include next steps or recommendations if applicable",
        guidelines: [
          "Summarize build results clearly",
          "Report test outcomes and coverage",
          "List files changed with purpose",
          "Flag known issues honestly",
          "Recommend next steps",
        ],
      },
      tools: ["read", "grep", "glob"],
      tags: ["reporting", "curtain", "summary", "communication"],
    },
  ];
}
