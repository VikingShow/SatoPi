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
}

export interface RoleAssetSummary {
  id: string;
  name: string;
  description: string;
  status: RoleStatus;
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
}

export interface RoleCreateInput {
  id: string;
  name: string;
  description: string;
  author?: string;
  prompts: {
    system: string;
    guidelines: string[];
  };
  tools: string[];
  tags: string[];
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
      author: input.author ?? "operator",
      status: "draft",
      prompts: {
        system: input.prompts.system,
        guidelines: input.prompts.guidelines,
      },
      tools: input.tools,
      tags: input.tags,
      created_at: now,
      updated_at: now,
      usage_count: 0,
      success_rate: 1.0,
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
    `created_at: "${role.created_at}"`,
    `updated_at: "${role.updated_at}"`,
    `usage_count: ${role.usage_count}`,
    `success_rate: ${role.success_rate}`,
  ];

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
      tags: ["devops", "ci-cd", "docker", "infrastructure", "deployment"],
    },
  ];
}
