import { useEffect, useState, useCallback } from "react";
import {
  Users, Search, Plus, CheckCircle2, XCircle, Clock,
  AlertCircle, ChevronDown, ChevronRight, Wrench, Tag,
  Trash2, RefreshCw, FileText, Loader2, Save
} from "lucide-react";
import { toast } from "sonner";
import { api } from "../../lib/api-client";
import type { RoleAssetSummary, RoleAsset, RoleStatus, RoleCreateInput } from "../../lib/types";

// ── Status badge ─────────────────────────────────────────────────────────

function statusColor(s: RoleStatus): string {
  switch (s) {
    case "approved": return "text-emerald-400 bg-emerald-400/10 border-emerald-400/30";
    case "proposed": return "text-amber-400 bg-amber-400/10 border-amber-400/30";
    case "draft": return "text-neutral-400 bg-neutral-400/10 border-neutral-400/30";
    case "deprecated": return "text-red-400 bg-red-400/10 border-red-400/30";
  }
}

function statusIcon(s: RoleStatus) {
  switch (s) {
    case "approved": return <CheckCircle2 size={12} />;
    case "proposed": return <Clock size={12} />;
    case "draft": return <AlertCircle size={12} />;
    case "deprecated": return <XCircle size={12} />;
  }
}

// ── Create form fields ────────────────────────────────────────────────────

interface CreateForm {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  guidelines: string;
  tools: string;
  tags: string;
}

// ── Props ─────────────────────────────────────────────────────────────────

interface RoleBrowserProps {
  /** When provided, enables role selection mode (for before-loop). */
  onSelect?: (roleId: string) => void;
  /** Currently selected role IDs (for selection mode). */
  selectedIds?: string[];
}

// ── Component ─────────────────────────────────────────────────────────────

export default function RoleBrowser({ onSelect, selectedIds }: RoleBrowserProps) {
  const [roles, setRoles] = useState<RoleAssetSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQ, setSearchQ] = useState("");
  const [filterStatus, setFilterStatus] = useState<RoleStatus | "all">("approved");
  const [filterTag, setFilterTag] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedRole, setExpandedRole] = useState<RoleAsset | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState<CreateForm>({
    id: "", name: "", description: "", systemPrompt: "",
    guidelines: "", tools: "", tags: "",
  });
  const [creating, setCreating] = useState(false);

  const emptyForm: CreateForm = {
    id: "", name: "", description: "", systemPrompt: "",
    guidelines: "", tools: "", tags: "",
  };

  const fetchRoles = useCallback(async () => {
    setLoading(true);
    try {
      let result: { roles: RoleAssetSummary[] };
      if (filterTag || searchQ) {
        result = await api.searchRoles({
          status: filterStatus === "all" ? undefined : filterStatus,
          tag: filterTag || undefined,
          q: searchQ || undefined,
        });
      } else {
        result = await api.getRoles(filterStatus === "all" ? undefined : filterStatus);
      }
      setRoles(result.roles);
    } catch (err) {
      console.error("Failed to fetch roles:", err);
    } finally {
      setLoading(false);
    }
  }, [filterStatus, filterTag, searchQ]);

  useEffect(() => {
    fetchRoles();
  }, [fetchRoles]);

  // Expand/collapse role detail
  const toggleExpand = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      setExpandedRole(null);
      return;
    }
    setExpandedId(id);
    setLoadingDetail(true);
    try {
      const role = await api.getRole(id);
      setExpandedRole(role);
    } catch {
      setExpandedRole(null);
    } finally {
      setLoadingDetail(false);
    }
  };

  // Actions
  const handleApprove = async (id: string) => {
    setActionBusy(id);
    try {
      await api.approveRole(id);
      toast.success(`Role "${id}" approved`);
      fetchRoles();
    } catch (err) {
      toast.error(`Failed to approve: ${String(err)}`);
    } finally {
      setActionBusy(null);
    }
  };

  const handleDeprecate = async (id: string) => {
    setActionBusy(id);
    try {
      await api.deprecateRole(id);
      toast.success(`Role "${id}" deprecated`);
      fetchRoles();
    } catch (err) {
      toast.error(`Failed to deprecate: ${String(err)}`);
    } finally {
      setActionBusy(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(`Delete role "${id}"? This cannot be undone.`)) return;
    setActionBusy(id);
    try {
      await api.deleteRole(id);
      toast.success(`Role "${id}" deleted`);
      if (expandedId === id) { setExpandedId(null); setExpandedRole(null); }
      fetchRoles();
    } catch (err) {
      toast.error(`Failed to delete: ${String(err)}`);
    } finally {
      setActionBusy(null);
    }
  };

  const handleCreate = async () => {
    if (!createForm.id.trim() || !createForm.name.trim() || !createForm.systemPrompt.trim()) {
      toast.error("ID, name, and system prompt are required");
      return;
    }
    setCreating(true);
    try {
      const input: RoleCreateInput = {
        id: createForm.id.trim(),
        name: createForm.name.trim(),
        description: createForm.description.trim(),
        prompts: {
          system: createForm.systemPrompt.trim(),
          guidelines: createForm.guidelines
            .split("\n")
            .map(g => g.trim())
            .filter(Boolean),
        },
        tools: createForm.tools
          .split(/[,\n]/)
          .map(t => t.trim())
          .filter(Boolean),
        tags: createForm.tags
          .split(/[,\n]/)
          .map(t => t.trim())
          .filter(Boolean),
      };
      await api.createRole(input);
      toast.success(`Role "${input.id}" created`);
      setShowCreate(false);
      setCreateForm(emptyForm);
      fetchRoles();
    } catch (err) {
      toast.error(`Failed to create: ${String(err)}`);
    } finally {
      setCreating(false);
    }
  };

  // All unique tags from roles
  const allTags = [...new Set(roles.flatMap(r => r.tags))].sort();

  const selectionSet = new Set(selectedIds ?? []);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800 bg-neutral-900/50">
        <div className="flex items-center gap-2">
          <Users size={16} className="text-primary" />
          <span className="text-sm font-medium">Role Library</span>
          <span className="text-xs text-neutral-600">({roles.length})</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => { setShowCreate(!showCreate); if (showCreate) setCreateForm(emptyForm); }}
            className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
              showCreate ? "bg-primary/20 text-primary" : "text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700"
            }`}
          >
            <Plus size={12} />
            Create
          </button>
          <button
            onClick={fetchRoles}
            className="p-1.5 rounded-md text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800 transition-colors cursor-pointer"
            title="Refresh"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="px-4 py-3 border-b border-neutral-800/50 bg-neutral-800/30 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-neutral-500 uppercase tracking-wider">Role ID *</label>
              <input
                type="text"
                value={createForm.id}
                onChange={e => setCreateForm(f => ({ ...f, id: e.target.value }))}
                placeholder="e.g. senior-backend-dev"
                className="w-full px-2 py-1 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 placeholder-neutral-500 focus:outline-none focus:border-primary/50"
              />
            </div>
            <div>
              <label className="text-[10px] text-neutral-500 uppercase tracking-wider">Name *</label>
              <input
                type="text"
                value={createForm.name}
                onChange={e => setCreateForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Senior Backend Developer"
                className="w-full px-2 py-1 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 placeholder-neutral-500 focus:outline-none focus:border-primary/50"
              />
            </div>
          </div>
          <div>
            <label className="text-[10px] text-neutral-500 uppercase tracking-wider">Description</label>
            <input
              type="text"
              value={createForm.description}
              onChange={e => setCreateForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Brief description of this role"
              className="w-full px-2 py-1 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 placeholder-neutral-500 focus:outline-none focus:border-primary/50"
            />
          </div>
          <div>
            <label className="text-[10px] text-neutral-500 uppercase tracking-wider">System Prompt *</label>
            <textarea
              value={createForm.systemPrompt}
              onChange={e => setCreateForm(f => ({ ...f, systemPrompt: e.target.value }))}
              placeholder="You are a senior backend developer..."
              rows={4}
              className="w-full px-2 py-1 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 placeholder-neutral-500 focus:outline-none focus:border-primary/50 resize-none font-mono"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-neutral-500 uppercase tracking-wider">Guidelines (one per line)</label>
              <textarea
                value={createForm.guidelines}
                onChange={e => setCreateForm(f => ({ ...f, guidelines: e.target.value }))}
                placeholder="Use TypeScript&#10;Write tests&#10;Document APIs"
                rows={3}
                className="w-full px-2 py-1 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 placeholder-neutral-500 focus:outline-none focus:border-primary/50 resize-none"
              />
            </div>
            <div>
              <label className="text-[10px] text-neutral-500 uppercase tracking-wider">Tools (comma separated)</label>
              <textarea
                value={createForm.tools}
                onChange={e => setCreateForm(f => ({ ...f, tools: e.target.value }))}
                placeholder="read_file, write_to_file, execute_command"
                rows={3}
                className="w-full px-2 py-1 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 placeholder-neutral-500 focus:outline-none focus:border-primary/50 resize-none font-mono"
              />
            </div>
          </div>
          <div>
            <label className="text-[10px] text-neutral-500 uppercase tracking-wider">Tags (comma separated)</label>
            <input
              type="text"
              value={createForm.tags}
              onChange={e => setCreateForm(f => ({ ...f, tags: e.target.value }))}
              placeholder="backend, typescript, api"
              className="w-full px-2 py-1 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 placeholder-neutral-500 focus:outline-none focus:border-primary/50"
            />
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={handleCreate}
              disabled={creating}
              className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-white hover:bg-primary/80 disabled:opacity-50 cursor-pointer transition-colors"
            >
              {creating ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              {creating ? "Creating..." : "Create Role"}
            </button>
            <button
              onClick={() => { setShowCreate(false); setCreateForm(emptyForm); }}
              className="px-3 py-1.5 text-xs text-neutral-500 hover:text-neutral-300 cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Search & Filter */}
      <div className="px-4 py-2 space-y-2 border-b border-neutral-800/50">
        <div className="flex items-center gap-2">
          <div className="flex-1 relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-600" />
            <input
              type="text"
              placeholder="Search roles..."
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-neutral-800 border border-neutral-700 rounded-md text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-primary/50"
            />
          </div>
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value as RoleStatus | "all")}
            className="px-2 py-1.5 text-xs bg-neutral-800 border border-neutral-700 rounded-md text-neutral-300 focus:outline-none focus:border-primary/50 cursor-pointer"
          >
            <option value="all">All status</option>
            <option value="approved">Approved</option>
            <option value="proposed">Proposed</option>
            <option value="draft">Draft</option>
            <option value="deprecated">Deprecated</option>
          </select>
        </div>

        {/* Tag chips */}
        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            <button
              onClick={() => setFilterTag("")}
              className={`px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors cursor-pointer ${
                filterTag === "" ? "bg-primary/20 text-primary" : "bg-neutral-800 text-neutral-500 hover:text-neutral-300"
              }`}
            >
              all
            </button>
            {allTags.map(tag => (
              <button
                key={tag}
                onClick={() => setFilterTag(filterTag === tag ? "" : tag)}
                className={`px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors cursor-pointer ${
                  filterTag === tag ? "bg-primary/20 text-primary" : "bg-neutral-800 text-neutral-500 hover:text-neutral-300"
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Role list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-neutral-600">
            <Loader2 size={20} className="animate-spin mr-2" />
            <span className="text-xs">Loading roles...</span>
          </div>
        ) : roles.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-neutral-600 gap-2">
            <FileText size={24} />
            <span className="text-xs">No roles found</span>
          </div>
        ) : (
          <div className="py-1">
            {roles.map(role => (
              <div key={role.id} className="border-b border-neutral-800/30 last:border-b-0">
                {/* Row */}
                <div
                  className={`flex items-center px-4 py-2.5 cursor-pointer transition-colors ${
                    selectionSet.has(role.id) ? "bg-primary/5" : "hover:bg-neutral-800/30"
                  }`}
                  onClick={() => onSelect ? onSelect(role.id) : toggleExpand(role.id)}
                >
                  {/* Expand toggle (non-selection mode) */}
                  {!onSelect && (
                    <button
                      onClick={e => { e.stopPropagation(); toggleExpand(role.id); }}
                      className="p-0.5 mr-2 text-neutral-600 hover:text-neutral-300 cursor-pointer"
                    >
                      {expandedId === role.id
                        ? <ChevronDown size={14} />
                        : <ChevronRight size={14} />
                      }
                    </button>
                  )}

                  {/* Selection checkbox */}
                  {onSelect && (
                    <div className={`w-4 h-4 mr-2.5 rounded border flex items-center justify-center flex-shrink-0 ${
                      selectionSet.has(role.id)
                        ? "bg-primary border-primary text-white"
                        : "border-neutral-600"
                    }`}>
                      {selectionSet.has(role.id) && <CheckCircle2 size={12} />}
                    </div>
                  )}

                  {/* Name + description */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-neutral-200 truncate">{role.name}</span>
                      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] border ${statusColor(role.status)}`}>
                        {statusIcon(role.status)}
                        {role.status}
                      </span>
                    </div>
                    <p className="text-xs text-neutral-500 truncate mt-0.5">{role.description}</p>
                  </div>

                  {/* Meta */}
                  <div className="flex items-center gap-3 ml-3 flex-shrink-0">
                    <div className="hidden sm:flex items-center gap-1">
                      <Tag size={10} className="text-neutral-600" />
                      <span className="text-[10px] text-neutral-600">{role.tags.slice(0, 2).join(", ")}</span>
                    </div>
                    <span className="text-[10px] text-neutral-600">
                      v{role.version} · {role.usage_count} uses
                    </span>
                  </div>

                  {/* Quick actions (non-selection mode) */}
                  {!onSelect && (
                    <div className="flex items-center gap-1 ml-2" onClick={e => e.stopPropagation()}>
                      {role.status === "proposed" && (
                        <button
                          onClick={() => handleApprove(role.id)}
                          disabled={actionBusy === role.id}
                          className="p-1 rounded text-emerald-500 hover:bg-emerald-500/10 disabled:opacity-50 cursor-pointer"
                          title="Approve"
                        >
                          {actionBusy === role.id ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                        </button>
                      )}
                      {role.status === "approved" && (
                        <button
                          onClick={() => handleDeprecate(role.id)}
                          disabled={actionBusy === role.id}
                          className="p-1 rounded text-amber-500 hover:bg-amber-500/10 disabled:opacity-50 cursor-pointer"
                          title="Deprecate"
                        >
                          <XCircle size={12} />
                        </button>
                      )}
                      <button
                        onClick={() => handleDelete(role.id)}
                        disabled={actionBusy === role.id}
                        className="p-1 rounded text-red-500/60 hover:text-red-400 hover:bg-red-500/10 disabled:opacity-50 cursor-pointer"
                        title="Delete"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  )}
                </div>

                {/* Expanded detail (non-selection mode) */}
                {!onSelect && expandedId === role.id && (
                  <div className="px-4 pb-3 pl-10">
                    {loadingDetail ? (
                      <div className="flex items-center gap-2 py-2 text-neutral-600 text-xs">
                        <Loader2 size={12} className="animate-spin" /> Loading...
                      </div>
                    ) : expandedRole ? (
                      <div className="space-y-3 py-2">
                        {/* System prompt */}
                        <div>
                          <span className="text-[10px] uppercase tracking-wider text-neutral-600 font-medium">System Prompt</span>
                          <pre className="mt-1 p-2 rounded-md bg-neutral-800/50 border border-neutral-700/50 text-xs text-neutral-400 whitespace-pre-wrap max-h-40 overflow-y-auto font-mono">
                            {expandedRole.prompts.system}
                          </pre>
                        </div>

                        {/* Guidelines */}
                        {expandedRole.prompts.guidelines.length > 0 && (
                          <div>
                            <span className="text-[10px] uppercase tracking-wider text-neutral-600 font-medium">Guidelines</span>
                            <ul className="mt-1 space-y-0.5">
                              {expandedRole.prompts.guidelines.map((g, i) => (
                                <li key={i} className="flex items-start gap-1.5 text-xs text-neutral-400">
                                  <span className="text-neutral-600 mt-0.5">-</span>
                                  {g}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {/* Tools */}
                        <div>
                          <span className="text-[10px] uppercase tracking-wider text-neutral-600 font-medium">Tools</span>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {expandedRole.tools.map(tool => (
                              <span key={tool} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-neutral-800 border border-neutral-700 text-[10px] text-neutral-400 font-mono">
                                <Wrench size={10} />
                                {tool}
                              </span>
                            ))}
                          </div>
                        </div>

                        {/* Meta footer */}
                        <div className="flex items-center gap-4 text-[10px] text-neutral-600">
                          <span>Author: {expandedRole.author}</span>
                          <span>Created: {new Date(expandedRole.created_at).toLocaleDateString()}</span>
                          <span>Updated: {new Date(expandedRole.updated_at).toLocaleDateString()}</span>
                          <span>Success: {(expandedRole.success_rate * 100).toFixed(0)}%</span>
                        </div>
                      </div>
                    ) : (
                      <div className="text-xs text-neutral-600 py-2">Failed to load role details.</div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
