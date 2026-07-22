import { useEffect, useState, useCallback } from "react";
import {
  Users, Search, Plus, CheckCircle2, XCircle, Clock,
  AlertCircle, ChevronDown, ChevronRight, Wrench, Tag,
  Trash2, RefreshCw, FileText, Loader2, Save, Pencil, X
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { api } from "../../lib/api-client";
import type { RoleAssetSummary, RoleAsset, RoleStatus, RoleCreateInput, RoleUpdateInput } from "../../lib/types";

// ── Status badge ─────────────────────────────────────────────────────────

function statusColor(s: RoleStatus): string {
  switch (s) {
    case "approved": return "text-emerald-400 bg-emerald-400/10 border-emerald-400/30";
    case "proposed": return "text-primary bg-primary/10 border-primary/30";
    case "draft": return "text-muted-foreground bg-muted-foreground/10 border-border/30";
    case "deprecated": return "text-status-danger bg-status-danger/10 border-status-danger/30";
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
  skills: string;
  mcpServers: string;
  model: string;
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
    guidelines: "", tools: "", tags: "", skills: "", mcpServers: "", model: "",
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

  // When a role is expanded and we've queued editing, populate the edit form.
  useEffect(() => {
    if (editingRoleId && expandedRole && expandedRole.id === editingRoleId && editForm.id !== editingRoleId) {
      setEditForm(roleToForm(expandedRole));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingRoleId, expandedRole]);

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

  // Edit support
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<CreateForm>({ ...emptyForm });
  const [updating, setUpdating] = useState(false);

  const roleToForm = (role: RoleAsset): CreateForm => ({
    id: role.id,
    name: role.name,
    description: role.description,
    systemPrompt: role.prompts.system,
    guidelines: role.prompts.guidelines.join("\n"),
    tools: role.tools.join(", "),
    tags: role.tags.join(", "),
    skills: (role.skills ?? []).join(", "),
    mcpServers: (role.mcp_servers ?? []).join(", "),
    model: role.model ?? "",
  });

  const handleStartEdit = () => {
    if (!expandedRole) return;
    setEditingRoleId(expandedRole.id);
    setEditForm(roleToForm(expandedRole));
  };

  const handleCancelEdit = () => {
    setEditingRoleId(null);
    setEditForm({ ...emptyForm });
  };

  const handleUpdate = async () => {
    if (!editingRoleId) return;
    if (!editForm.name.trim() || !editForm.systemPrompt.trim()) {
      toast.error("Name and system prompt are required");
      return;
    }
    setUpdating(true);
    try {
      const input: RoleUpdateInput = {
        name: editForm.name.trim(),
        description: editForm.description.trim(),
        prompts: {
          system: editForm.systemPrompt.trim(),
          guidelines: editForm.guidelines.split("\n").map(g => g.trim()).filter(Boolean),
        },
        tools: editForm.tools.split(/[,\n]/).map(t => t.trim()).filter(Boolean),
        tags: editForm.tags.split(/[,\n]/).map(t => t.trim()).filter(Boolean),
        skills: editForm.skills
          ? editForm.skills.split(/[,\n]/).map(s => s.trim()).filter(Boolean)
          : [],
        mcp_servers: editForm.mcpServers
          ? editForm.mcpServers.split(/[,\n]/).map(m => m.trim()).filter(Boolean)
          : [],
        model: editForm.model.trim() || undefined,
      };
      const updated = await api.updateRole(editingRoleId, input);
      setExpandedRole(updated);
      toast.success(`Role "${editingRoleId}" updated`);
      handleCancelEdit();
      fetchRoles();
    } catch (err) {
      toast.error(`Failed to update: ${String(err)}`);
    } finally {
      setUpdating(false);
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
        skills: createForm.skills
          ? createForm.skills.split(/[,\n]/).map(s => s.trim()).filter(Boolean)
          : undefined,
        mcp_servers: createForm.mcpServers
          ? createForm.mcpServers.split(/[,\n]/).map(m => m.trim()).filter(Boolean)
          : undefined,
        model: createForm.model.trim() || undefined,
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
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-background/50">
        <div className="flex items-center gap-2">
          <Users size={16} className="text-primary" />
          <span className="text-sm font-medium">Role Library</span>
          <span className="text-xs text-muted-foreground/60">({roles.length})</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => { setShowCreate(true); setCreateForm(emptyForm); }}
          >
            <Plus size={12} />
            Create
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={fetchRoles}
            title="Refresh"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </Button>
        </div>
      </div>

      {/* Create modal */}
      <Dialog open={showCreate} onOpenChange={(open) => { setShowCreate(open); if (!open) setCreateForm(emptyForm); }}>
        <DialogContent className="sm:max-w-xl max-h-[85vh] overflow-y-auto" showCloseButton={true}>
          <DialogHeader>
            <DialogTitle className="text-base font-medium">Create New Role</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Role ID *</label>
              <input
                type="text"
                value={createForm.id}
                onChange={e => setCreateForm(f => ({ ...f, id: e.target.value }))}
                placeholder="e.g. senior-backend-dev"
                className="w-full px-2 py-1 text-xs bg-background-elevated border border-border rounded text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
              />
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Name *</label>
              <input
                type="text"
                value={createForm.name}
                onChange={e => setCreateForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Senior Backend Developer"
                className="w-full px-2 py-1 text-xs bg-background-elevated border border-border rounded text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
              />
            </div>
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Description</label>
            <input
              type="text"
              value={createForm.description}
              onChange={e => setCreateForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Brief description of this role"
              className="w-full px-2 py-1 text-xs bg-background-elevated border border-border rounded text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
            />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider">System Prompt *</label>
            <textarea
              value={createForm.systemPrompt}
              onChange={e => setCreateForm(f => ({ ...f, systemPrompt: e.target.value }))}
              placeholder="You are a senior backend developer..."
              rows={4}
              className="w-full px-2 py-1 text-xs bg-background-elevated border border-border rounded text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 resize-none font-mono"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Guidelines (one per line)</label>
              <textarea
                value={createForm.guidelines}
                onChange={e => setCreateForm(f => ({ ...f, guidelines: e.target.value }))}
                placeholder="Use TypeScript&#10;Write tests&#10;Document APIs"
                rows={3}
                className="w-full px-2 py-1 text-xs bg-background-elevated border border-border rounded text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 resize-none"
              />
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Tools (comma separated)</label>
              <textarea
                value={createForm.tools}
                onChange={e => setCreateForm(f => ({ ...f, tools: e.target.value }))}
                placeholder="read_file, write_to_file, execute_command"
                rows={3}
                className="w-full px-2 py-1 text-xs bg-background-elevated border border-border rounded text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 resize-none font-mono"
              />
            </div>
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Tags (comma separated)</label>
            <input
              type="text"
              value={createForm.tags}
              onChange={e => setCreateForm(f => ({ ...f, tags: e.target.value }))}
              placeholder="backend, typescript, api"
              className="w-full px-2 py-1 text-xs bg-background-elevated border border-border rounded text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
            />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Skills (comma separated)</label>
            <input
              type="text"
              value={createForm.skills}
              onChange={e => setCreateForm(f => ({ ...f, skills: e.target.value }))}
              placeholder="grill-me, grill-with-docs"
              className="w-full px-2 py-1 text-xs bg-background-elevated border border-border rounded text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
            />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider">MCP Servers (comma separated)</label>
            <input
              type="text"
              value={createForm.mcpServers}
              onChange={e => setCreateForm(f => ({ ...f, mcpServers: e.target.value }))}
              placeholder="filesystem, github"
              className="w-full px-2 py-1 text-xs bg-background-elevated border border-border rounded text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
            />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Model override</label>
            <input
              type="text"
              value={createForm.model}
              onChange={e => setCreateForm(f => ({ ...f, model: e.target.value }))}
              placeholder="leave empty for default"
              className="w-full px-2 py-1 text-xs bg-background-elevated border border-border rounded text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
            />
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Button
              variant="default"
              size="sm"
              onClick={handleCreate}
              disabled={creating}
            >
              {creating ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              {creating ? "Creating..." : "Create Role"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setShowCreate(false); setCreateForm(emptyForm); }}
            >
              Cancel
            </Button>
          </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Search & Filter */}
      <div className="px-4 py-2 space-y-2 border-b border-border/50">
        <div className="flex items-center gap-2">
          <div className="flex-1 relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
            <input
              type="text"
              placeholder="Search roles..."
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-card border border-border rounded-md text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
            />
          </div>
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value as RoleStatus | "all")}
            className="px-2 py-1.5 text-xs bg-card border border-border rounded-md text-foreground/80 focus:outline-none focus:border-primary/50 cursor-pointer"
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
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setFilterTag("")}
              className={`rounded-full px-2 py-0.5 text-[10px] ${
                filterTag === "" ? "bg-primary/20 text-primary" : "bg-card text-muted-foreground hover:text-foreground/80"
              }`}
            >
              all
            </Button>
            {allTags.map(tag => (
              <Button
                variant="ghost"
                size="xs"
                key={tag}
                onClick={() => setFilterTag(filterTag === tag ? "" : tag)}
                className={`rounded-full px-2 py-0.5 text-[10px] ${
                  filterTag === tag ? "bg-primary/20 text-primary" : "bg-card text-muted-foreground hover:text-foreground/80"
                }`}
              >
                {tag}
              </Button>
            ))}
          </div>
        )}
      </div>

      {/* Role list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground/60">
            <Loader2 size={20} className="animate-spin mr-2" />
            <span className="text-xs">Loading roles...</span>
          </div>
        ) : roles.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground/60 gap-2">
            <FileText size={24} />
            <span className="text-xs">No roles found</span>
          </div>
        ) : (
          <div className="py-1">
            {roles.map(role => (
              <div key={role.id} className="border-b border-border/30 last:border-b-0">
                {/* Row */}
                <div
                  className={`flex items-center px-4 py-2.5 cursor-pointer transition-colors ${
                    selectionSet.has(role.id) ? "bg-primary/5" : "hover:bg-card/30"
                  }`}
                  onClick={() => onSelect ? onSelect(role.id) : toggleExpand(role.id)}
                >
                  {/* Expand toggle (non-selection mode) */}
                  {!onSelect && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={e => { e.stopPropagation(); toggleExpand(role.id); }}
                      className="mr-2 text-muted-foreground/60 hover:text-foreground/80"
                    >
                      {expandedId === role.id
                        ? <ChevronDown size={14} />
                        : <ChevronRight size={14} />
                      }
                    </Button>
                  )}

                  {/* Selection checkbox */}
                  {onSelect && (
                    <div className={`w-4 h-4 mr-2.5 rounded border flex items-center justify-center flex-shrink-0 ${
                      selectionSet.has(role.id)
                        ? "bg-primary border-primary text-foreground"
                        : "border-border"
                    }`}>
                      {selectionSet.has(role.id) && <CheckCircle2 size={12} />}
                    </div>
                  )}

                  {/* Name + description */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground truncate">{role.name}</span>
                      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] border ${statusColor(role.status)}`}>
                        {statusIcon(role.status)}
                        {role.status}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground truncate mt-0.5">{role.description}</p>
                  </div>

                  {/* Meta */}
                  <div className="flex items-center gap-3 ml-3 flex-shrink-0">
                    <div className="hidden sm:flex items-center gap-1">
                      <Tag size={10} className="text-muted-foreground/60" />
                      <span className="text-[10px] text-muted-foreground/60">{role.tags.slice(0, 2).join(", ")}</span>
                    </div>
                    <span className="text-[10px] text-muted-foreground/60">
                      v{role.version} · {role.usage_count} uses
                    </span>
                  </div>

                  {/* Quick actions (non-selection mode) */}
                  {!onSelect && (
                    <div className="flex items-center gap-1 ml-2" onClick={e => e.stopPropagation()}>
                      {role.status === "proposed" && (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => handleApprove(role.id)}
                          disabled={actionBusy === role.id}
                          className="text-status-success hover:bg-status-success/10"
                          title="Approve"
                        >
                          {actionBusy === role.id ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                        </Button>
                      )}
                      {role.status === "approved" && (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => handleDeprecate(role.id)}
                          disabled={actionBusy === role.id}
                          className="text-primary hover:bg-primary/10"
                          title="Deprecate"
                        >
                          <XCircle size={12} />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => {
                          if (expandedId !== role.id) {
                            setEditingRoleId(role.id); // mark for edit after expand loads
                            toggleExpand(role.id);
                          } else {
                            handleStartEdit();
                          }
                        }}
                        disabled={actionBusy === role.id}
                        className="text-muted-foreground/60 hover:text-foreground/80"
                        title="Edit"
                      >
                        <Pencil size={12} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => handleDelete(role.id)}
                        disabled={actionBusy === role.id}
                        className="text-status-danger/60 hover:text-status-danger hover:bg-status-danger/10"
                        title="Delete"
                      >
                        <Trash2 size={12} />
                      </Button>
                    </div>
                  )}
                </div>

                {/* Expanded detail / edit form (non-selection mode) */}
                {!onSelect && expandedId === role.id && (
                  <div className="px-4 pb-3 pl-10">
                    <ExpandedDetail
                      loading={loadingDetail}
                      role={expandedRole}
                      editing={editingRoleId === role.id}
                      editForm={editForm}
                      onEditFormChange={setEditForm}
                      onCancelEdit={handleCancelEdit}
                      onUpdate={handleUpdate}
                      updating={updating}
                    />
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

/** Renders the expanded detail pane: loading spinner, edit form, or view-only detail. */
function ExpandedDetail({
  loading,
  role,
  editing,
  editForm,
  onEditFormChange,
  onCancelEdit,
  onUpdate,
  updating,
}: {
  loading: boolean;
  role: RoleAsset | null;
  editing: boolean;
  editForm: CreateForm;
  onEditFormChange: (f: CreateForm) => void;
  onCancelEdit: () => void;
  onUpdate: () => void;
  updating: boolean;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 py-2 text-muted-foreground/60 text-xs">
        <Loader2 size={12} className="animate-spin" /> Loading...
      </div>
    );
  }

  if (!role) {
    return <div className="text-xs text-muted-foreground/60 py-2">Failed to load role details.</div>;
  }

  if (editing) {
    return (
      <div className="space-y-3 py-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-foreground/80">Editing: {role.name}</span>
          <Button variant="ghost" size="icon-xs" onClick={onCancelEdit} title="Cancel">
            <X size={12} />
          </Button>
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Name</label>
          <input type="text" value={editForm.name}
            onChange={e => onEditFormChange({ ...editForm, name: e.target.value })}
            className="w-full px-2 py-1 text-xs bg-background-elevated border border-border rounded text-foreground focus:outline-none focus:border-primary/50" />
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Description</label>
          <input type="text" value={editForm.description}
            onChange={e => onEditFormChange({ ...editForm, description: e.target.value })}
            className="w-full px-2 py-1 text-xs bg-background-elevated border border-border rounded text-foreground focus:outline-none focus:border-primary/50" />
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground uppercase tracking-wider">System Prompt</label>
          <textarea value={editForm.systemPrompt}
            onChange={e => onEditFormChange({ ...editForm, systemPrompt: e.target.value })} rows={4}
            className="w-full px-2 py-1 text-xs bg-background-elevated border border-border rounded text-foreground font-mono focus:outline-none focus:border-primary/50" />
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Guidelines (one per line)</label>
          <textarea value={editForm.guidelines}
            onChange={e => onEditFormChange({ ...editForm, guidelines: e.target.value })} rows={3}
            className="w-full px-2 py-1 text-xs bg-background-elevated border border-border rounded text-foreground font-mono focus:outline-none focus:border-primary/50" />
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Tools (comma separated)</label>
          <input type="text" value={editForm.tools}
            onChange={e => onEditFormChange({ ...editForm, tools: e.target.value })}
            className="w-full px-2 py-1 text-xs bg-background-elevated border border-border rounded text-foreground focus:outline-none focus:border-primary/50" />
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Tags</label>
          <input type="text" value={editForm.tags}
            onChange={e => onEditFormChange({ ...editForm, tags: e.target.value })}
            className="w-full px-2 py-1 text-xs bg-background-elevated border border-border rounded text-foreground focus:outline-none focus:border-primary/50" />
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Skills (comma separated)</label>
          <input type="text" value={editForm.skills}
            onChange={e => onEditFormChange({ ...editForm, skills: e.target.value })}
            className="w-full px-2 py-1 text-xs bg-background-elevated border border-border rounded text-foreground focus:outline-none focus:border-primary/50" />
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground uppercase tracking-wider">MCP Servers (comma separated)</label>
          <input type="text" value={editForm.mcpServers}
            onChange={e => onEditFormChange({ ...editForm, mcpServers: e.target.value })}
            className="w-full px-2 py-1 text-xs bg-background-elevated border border-border rounded text-foreground focus:outline-none focus:border-primary/50" />
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Model override</label>
          <input type="text" value={editForm.model}
            onChange={e => onEditFormChange({ ...editForm, model: e.target.value })}
            className="w-full px-2 py-1 text-xs bg-background-elevated border border-border rounded text-foreground focus:outline-none focus:border-primary/50" />
        </div>
        <Button variant="default" size="xs" onClick={onUpdate} disabled={updating}
          className="bg-status-success hover:bg-status-success/80">
          {updating ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
          Save Changes
        </Button>
      </div>
    );
  }

  // View-only detail
  return (
    <div className="space-y-3 py-2">
      <div>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-medium">System Prompt</span>
        <pre className="mt-1 p-2 rounded-md bg-card/50 border border-border/50 text-xs text-muted-foreground whitespace-pre-wrap max-h-40 overflow-y-auto font-mono">
          {role.prompts.system}
        </pre>
      </div>

      {role.prompts.guidelines.length > 0 && (
        <div>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-medium">Guidelines</span>
          <ul className="mt-1 space-y-0.5">
            {role.prompts.guidelines.map((g, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <span className="text-muted-foreground/60 mt-0.5">-</span>
                {g}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-medium">Tools</span>
        <div className="mt-1 flex flex-wrap gap-1">
          {role.tools.map(tool => (
            <span key={tool} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-card border border-border text-[10px] text-muted-foreground font-mono">
              <Wrench size={10} />
              {tool}
            </span>
          ))}
        </div>
      </div>

      {role.skills && role.skills.length > 0 && (
        <div>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-medium">Skills</span>
          <div className="mt-1 flex flex-wrap gap-1">
            {role.skills.map(s => (
              <span key={s} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-card border border-border text-[10px] text-muted-foreground font-mono">
                {s}
              </span>
            ))}
          </div>
        </div>
      )}

      {role.mcp_servers && role.mcp_servers.length > 0 && (
        <div>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-medium">MCP Servers</span>
          <div className="mt-1 flex flex-wrap gap-1">
            {role.mcp_servers.map(m => (
              <span key={m} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-card border border-border text-[10px] text-muted-foreground font-mono">
                {m}
              </span>
            ))}
          </div>
        </div>
      )}

      {role.model && (
        <div>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-medium">Model</span>
          <div className="mt-1 text-xs text-muted-foreground font-mono">{role.model}</div>
        </div>
      )}

      <div className="flex items-center gap-4 text-[10px] text-muted-foreground/60">
        <span>Author: {role.author}</span>
        <span>Created: {new Date(role.created_at).toLocaleDateString()}</span>
        <span>Updated: {new Date(role.updated_at).toLocaleDateString()}</span>
        <span>Success: {(role.success_rate * 100).toFixed(0)}%</span>
      </div>
    </div>
  );
}
