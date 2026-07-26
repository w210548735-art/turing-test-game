import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useState,
} from "react";
import type { AccountSessionResponse } from "@turing-game/protocol";

type SettingsPanel = "profile" | "password" | "delete" | null;
type SettingsTone = "root" | "identity" | "security" | "help" | "danger";

export function AccountSettingsPage({
  accountUser,
  busy,
  onBack,
  onSaveDisplayName,
  onChangePassword,
  onLogout,
  onDeleteAccount,
  onAdmin,
  onCreator,
  onSupport,
  onFeedback,
}: {
  accountUser: AccountSessionResponse["user"];
  busy: boolean;
  onBack: () => void;
  onSaveDisplayName: (displayName: string) => Promise<void>;
  onChangePassword: (
    currentPassword: string,
    newPassword: string,
  ) => Promise<void>;
  onLogout: () => void;
  onDeleteAccount: (
    currentPassword: string,
    confirmation: string,
  ) => Promise<void>;
  onAdmin?: () => void;
  onCreator: () => void;
  onSupport: () => void;
  onFeedback: () => void;
}) {
  const [activePanel, setActivePanel] = useState<SettingsPanel>(null);
  const [displayName, setDisplayName] = useState(accountUser.displayName);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [panelBusy, setPanelBusy] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [panelMessage, setPanelMessage] = useState<string | null>(null);

  useEffect(() => {
    setDisplayName(accountUser.displayName);
  }, [accountUser.displayName]);

  function openPanel(panel: Exclude<SettingsPanel, null>) {
    setPanelError(null);
    setPanelMessage(null);
    setActivePanel(panel);
  }

  function closePanel() {
    if (panelBusy) return;
    setActivePanel(null);
    setPanelError(null);
    setPanelMessage(null);
    setCurrentPassword("");
    setNewPassword("");
    setPasswordConfirmation("");
    setDeletePassword("");
    setDeleteConfirmation("");
  }

  async function submitDisplayName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextName = displayName.trim();
    if (panelBusy || nextName.length < 2) return;
    setPanelBusy(true);
    setPanelError(null);
    setPanelMessage(null);
    try {
      await onSaveDisplayName(nextName);
      setDisplayName(nextName);
      setPanelMessage("全局名称已经保存好啦 ( •̀ ω •́ )✧");
    } catch (error) {
      setPanelError(
        error instanceof Error
          ? error.message
          : "名称没有保存成功，请稍后重试。",
      );
    } finally {
      setPanelBusy(false);
    }
  }

  async function submitPasswordChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (panelBusy) return;
    if (newPassword !== passwordConfirmation) {
      setPanelMessage(null);
      setPanelError("两次输入的新密码不一致。");
      return;
    }
    setPanelBusy(true);
    setPanelError(null);
    setPanelMessage(null);
    try {
      await onChangePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setPasswordConfirmation("");
      setPanelMessage(
        "密码修改成功啦，其他设备的登录会话已经退出 ( •̀ ω •́ )✧",
      );
    } catch (error) {
      setPanelError(
        error instanceof Error
          ? error.message
          : "密码没有修改成功，请稍后重试。",
      );
    } finally {
      setPanelBusy(false);
    }
  }

  async function submitAccountDeletion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (panelBusy || deleteConfirmation !== "注销") return;
    setPanelBusy(true);
    setPanelError(null);
    setPanelMessage(null);
    try {
      await onDeleteAccount(deletePassword, deleteConfirmation);
    } catch (error) {
      setPanelError(
        error instanceof Error
          ? error.message
          : "账号暂时没有注销成功，请稍后重试。",
      );
      setPanelBusy(false);
    }
  }

  return (
    <section className="account-settings-page view-page-enter">
      <header className="account-settings-header">
        <button className="record-back" type="button" onClick={onBack}>
          ← 返回玩家档案
        </button>
        <div className="account-settings-title">
          <p>ACCOUNT / SETTINGS</p>
          <h1>账户设置</h1>
          <span>管理公开身份、账户安全与全局偏好</span>
        </div>
        <aside
          className="account-settings-identity-card"
          aria-label="当前账户身份"
        >
          <span className="account-settings-avatar" aria-hidden="true">
            {accountUser.displayName.slice(0, 1)}
          </span>
          <div>
            <small>GLOBAL IDENTITY</small>
            <strong>{accountUser.displayName}</strong>
            <span>NO. {accountUser.playerNumber}</span>
          </div>
          <em>{accountUser.role === "ROOT" ? "ROOT" : "PLAYER"}</em>
        </aside>
      </header>

      <div className="account-settings-groups">
        {accountUser.role === "ROOT" && onAdmin && (
          <SettingsGroup
            eyebrow="ROOT / OPERATIONS"
            title="运营管理"
            tone="root"
          >
            <button
              className="account-setting-row"
              type="button"
              onClick={onAdmin}
            >
              <span>打开运营后台</span>
              <strong>实时用户、匹配、Token 与运营待办</strong>
              <i aria-hidden="true">↗</i>
            </button>
          </SettingsGroup>
        )}

        <SettingsGroup eyebrow="IDENTITY" title="账户资料" tone="identity">
          <button
            className="account-setting-row"
            type="button"
            onClick={() => openPanel("profile")}
          >
            <span>全局账户名称</span>
            <strong>{accountUser.displayName}</strong>
            <i aria-hidden="true">↗</i>
          </button>
          <div className="account-setting-row is-static">
            <span>玩家编号</span>
            <strong>NO. {accountUser.playerNumber}</strong>
          </div>
        </SettingsGroup>

        <SettingsGroup eyebrow="SECURITY" title="账户安全" tone="security">
          <button
            className="account-setting-row"
            type="button"
            onClick={() => openPanel("password")}
          >
            <span>修改账号密码</span>
            <strong>修改后退出其他设备</strong>
            <i aria-hidden="true">↗</i>
          </button>
          <button
            className="account-setting-row"
            type="button"
            disabled={busy}
            onClick={onLogout}
          >
            <span>退出当前账号</span>
            <strong>{busy ? "正在退出…" : "结束当前设备会话"}</strong>
            <i aria-hidden="true">↗</i>
          </button>
        </SettingsGroup>

        <SettingsGroup eyebrow="HELP & ABOUT" title="帮助与关于" tone="help">
          <button
            className="account-setting-row"
            type="button"
            onClick={onFeedback}
          >
            <span>问题 / Bug 反馈</span>
            <strong>感谢你的反馈喵</strong>
            <i aria-hidden="true">↗</i>
          </button>
          <button
            className="account-setting-row"
            type="button"
            onClick={onCreator}
          >
            <span>关注作者</span>
            <strong>B 站 · 抖音 · GitHub</strong>
            <i aria-hidden="true">↗</i>
          </button>
          <button
            className="account-setting-row"
            type="button"
            onClick={onSupport}
          >
            <span>请作者喝杯奶茶</span>
            <strong>量力支持就好喵 ☕</strong>
            <i aria-hidden="true">↗</i>
          </button>
        </SettingsGroup>

        <SettingsGroup
          eyebrow="DANGER ZONE"
          title="危险操作"
          danger
          tone="danger"
        >
          <button
            className="account-setting-row is-danger"
            type="button"
            onClick={() => openPanel("delete")}
          >
            <span>注销账号</span>
            <strong>永久匿名化并撤销全部会话</strong>
            <i aria-hidden="true">↗</i>
          </button>
        </SettingsGroup>
      </div>

      {activePanel && (
        <div className="account-settings-panel-backdrop" role="presentation">
          <section
            className={`account-settings-panel is-${activePanel}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`settings-${activePanel}-title`}
          >
            <button
              className="modal-close"
              type="button"
              disabled={panelBusy}
              aria-label="关闭设置面板"
              onClick={closePanel}
            >
              ×
            </button>

            {activePanel === "profile" && (
              <form onSubmit={(event) => void submitDisplayName(event)}>
                <p>GLOBAL IDENTITY</p>
                <h2 id="settings-profile-title">修改全局账户名称</h2>
                <label className="field">
                  <span>全局账户名称</span>
                  <input
                    autoFocus
                    type="text"
                    value={displayName}
                    minLength={2}
                    maxLength={18}
                    autoComplete="nickname"
                    onChange={(event) => setDisplayName(event.target.value)}
                  />
                  <small>{displayName.length}/18</small>
                </label>
                <p className="settings-panel-note">
                  本局临时名称仍在每次进入 1v1 前单独设置。
                </p>
                <button
                  className="primary-action"
                  type="submit"
                  disabled={
                    panelBusy ||
                    displayName.trim().length < 2 ||
                    displayName.trim() === accountUser.displayName
                  }
                >
                  {panelBusy ? "保存中…" : "保存名称"}
                </button>
              </form>
            )}

            {activePanel === "password" && (
              <form onSubmit={(event) => void submitPasswordChange(event)}>
                <p>ACCOUNT SECURITY</p>
                <h2 id="settings-password-title">修改账号密码</h2>
                <label className="field">
                  <span>当前密码</span>
                  <input
                    autoFocus
                    type="password"
                    minLength={12}
                    maxLength={128}
                    required
                    autoComplete="current-password"
                    value={currentPassword}
                    onChange={(event) =>
                      setCurrentPassword(event.target.value)
                    }
                  />
                </label>
                <label className="field">
                  <span>新密码</span>
                  <input
                    type="password"
                    minLength={12}
                    maxLength={128}
                    required
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>再次输入新密码</span>
                  <input
                    type="password"
                    minLength={12}
                    maxLength={128}
                    required
                    autoComplete="new-password"
                    value={passwordConfirmation}
                    onChange={(event) =>
                      setPasswordConfirmation(event.target.value)
                    }
                  />
                </label>
                <button
                  className="primary-action"
                  type="submit"
                  disabled={
                    panelBusy ||
                    currentPassword.length < 12 ||
                    newPassword.length < 12 ||
                    passwordConfirmation.length < 12
                  }
                >
                  {panelBusy ? "修改中…" : "确认修改密码"}
                </button>
              </form>
            )}

            {activePanel === "delete" && (
              <form onSubmit={(event) => void submitAccountDeletion(event)}>
                <p>DANGER / PERMANENT</p>
                <h2 id="settings-delete-title">永久注销账号</h2>
                <div className="account-delete-warning" role="note">
                  <strong>此操作无法撤销</strong>
                  <span>
                    账户身份将被匿名化，所有设备都会退出；当前设备中的本机战绩也会清除。
                  </span>
                </div>
                <label className="field">
                  <span>当前密码</span>
                  <input
                    autoFocus
                    type="password"
                    minLength={12}
                    maxLength={128}
                    required
                    autoComplete="current-password"
                    value={deletePassword}
                    onChange={(event) => setDeletePassword(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>输入“注销”确认</span>
                  <input
                    type="text"
                    required
                    autoComplete="off"
                    value={deleteConfirmation}
                    onChange={(event) =>
                      setDeleteConfirmation(event.target.value)
                    }
                  />
                </label>
                <button
                  className="danger-action"
                  type="submit"
                  disabled={
                    panelBusy ||
                    deletePassword.length < 12 ||
                    deleteConfirmation !== "注销"
                  }
                >
                  {panelBusy ? "正在注销…" : "永久注销账号"}
                </button>
              </form>
            )}

            {panelError && (
              <p className="field-error" role="alert">{panelError}</p>
            )}
            {panelMessage && (
              <p className="form-message" role="status">{panelMessage}</p>
            )}
          </section>
        </div>
      )}
    </section>
  );
}

function SettingsGroup({
  eyebrow,
  title,
  danger = false,
  tone = "identity",
  children,
}: {
  eyebrow: string;
  title: string;
  danger?: boolean;
  tone?: SettingsTone;
  children: ReactNode;
}) {
  return (
    <section
      className={`account-settings-group is-${tone}`}
    >
      <header>
        <span>{eyebrow}</span>
        <h2>{title}</h2>
      </header>
      <div>{children}</div>
    </section>
  );
}
