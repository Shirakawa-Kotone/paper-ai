import { useCallback, useEffect, useState } from 'react';
import { api, type ExamSummary, type SettingsPayload } from '../api.ts';
import { SUBJECTS } from '../../../shared/types.ts';
import type { AiProviderId, ExamDetail } from '../../../shared/types.ts';
import { Badge, Field, Modal, Spinner, useToast } from '../components/ui.tsx';
import { Icon } from '../icons.tsx';
import { ModelPicker, type ModelOption } from '../components/ModelPicker.tsx';
import { collectReviewItems } from '../review.ts';

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [modelList, setModelList] = useState<{ id: string; vision: boolean }[] | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);

  const [provider, setProvider] = useState<AiProviderId>('deepseek');
  const [baseURL, setBaseURL] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [textModel, setTextModel] = useState('');
  const [visionModel, setVisionModel] = useState('');
  const [concurrency, setConcurrency] = useState(3);
  const [jsonMode, setJsonMode] = useState(true);


  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await api.settings();
      setData(s);
      setProvider(s.ai.provider);
      setBaseURL(s.ai.baseURL);
      setTextModel(s.ai.textModel);
      setVisionModel(s.ai.visionModel);
      setConcurrency(s.ai.concurrency);
      setJsonMode(s.ai.jsonMode);
      setApiKey('');
    } catch (err) {
      toast((err as Error).message, 'bad');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (open) {
      setTestResult(null);
      setModelList(null);
      void load();
    }
  }, [open, load]);

  const applyProvider = (id: AiProviderId) => {
    setProvider(id);
    setModelList(null);
    const p = data?.providers.find((x) => x.id === id);
    if (!p) return;
    if (p.baseURL) setBaseURL(p.baseURL);
    if (p.textModel) setTextModel(p.textModel);
    if (p.visionModel) setVisionModel(p.visionModel);
    setJsonMode(p.supportsJsonMode);
  };

  const save = async () => {
    setSaving(true);
    try {
      const patchBody: Record<string, unknown> = {
        provider,
        baseURL: baseURL.trim(),
        textModel: textModel.trim(),
        visionModel: visionModel.trim(),
        concurrency,
        jsonMode,
      };
      if (apiKey.trim()) patchBody.apiKey = apiKey.trim();
      await api.saveAi(patchBody);
      toast('设置已保存', 'ok');
      onClose();
    } catch (err) {
      toast((err as Error).message, 'bad');
    } finally {
      setSaving(false);
    }
  };

  const fetchModels = async (silent = false) => {
    setLoadingModels(true);
    try {
      const r = await api.listModels({ baseURL: baseURL.trim(), apiKey: apiKey.trim() });
      setModelList(r.models);
      if (!silent) toast(`拿到 ${r.models.length} 个模型，其中 ${r.visionCount} 个支持图片`, 'ok');
      return r.models;
    } catch (err) {
      if (!silent) toast((err as Error).message, 'bad');
      return null;
    } finally {
      setLoadingModels(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      // 先保存再测，避免测的是旧配置
      const patchBody: Record<string, unknown> = {
        provider,
        baseURL: baseURL.trim(),
        textModel: textModel.trim(),
        visionModel: visionModel.trim(),
        concurrency,
        jsonMode,
      };
      if (apiKey.trim()) patchBody.apiKey = apiKey.trim();
      await api.saveAi(patchBody);
      const r = await api.testAi();
      setTestResult({ ok: true, text: `连接正常（${r.model}，${r.ms}ms）：${r.reply || '无回复'}` });
      toast('连接正常', 'ok');
      void fetchModels(true);
    } catch (err) {
      setTestResult({ ok: false, text: (err as Error).message });
      toast('连接失败', 'bad');
    } finally {
      setTesting(false);
    }
  };

  const preset = data?.providers.find((p) => p.id === provider);

  const modelOptions: ModelOption[] = modelList
    ? modelList
    : [
        ...(preset?.models.text ?? []).map((id) => ({
          id,
          vision: (preset?.models.vision ?? []).includes(id),
        })),
        ...(preset?.models.vision ?? [])
          .filter((id) => !(preset?.models.text ?? []).includes(id))
          .map((id) => ({ id, vision: true })),
      ];

  return (
    <Modal
      open={open}
      wide
      title="设置"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? <Spinner light /> : <Icon name="check" size={15} />}
            保存
          </button>
        </>
      }
    >
      {loading || !data ? (
        <div className="row" style={{ justifyContent: 'center', padding: 30 }}>
          <Spinner />
        </div>
      ) : (
        <div className="stack">
          <section className="field">
            <div className="label">模型服务商</div>
            <div className="provider-grid">
              {data.providers.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`provider ${provider === p.id ? 'active' : ''}`}
                  onClick={() => applyProvider(p.id)}
                >
                  <div className="name">{p.label}</div>
                  <div className="meta">
                    {p.supportsVision ? '支持图片' : '仅文本'} · {p.id}
                  </div>
                </button>
              ))}
            </div>
          </section>

          <div className="grid-2">
            <Field label="接口地址 Base URL" hint="OpenAI 兼容地址，例如 https://api.deepseek.com/v1">
              <input
                className="input"
                value={baseURL}
                onChange={(e) => setBaseURL(e.target.value)}
                onBlur={() => {
                  if (baseURL.trim() && !modelList && !loadingModels) void fetchModels(true);
                }}
                placeholder="https://…/v1"
              />
            </Field>
            <Field
              label="API Key"
              hint={
                data.envKey
                  ? '已通过环境变量 PAPER_AI_API_KEY 提供，优先级高于此处'
                  : data.ai.hasApiKey
                    ? `已保存（${data.ai.apiKeyMask}）。留空表示不修改`
                    : '仅保存在本机数据库，不会上传'
              }
            >
              <input
                className="input"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onBlur={() => {
                  if (apiKey.trim().length > 8 && baseURL.trim() && !modelList && !loadingModels) {
                    void fetchModels(true);
                  }
                }}
                placeholder={data.ai.hasApiKey ? '••••••（留空不修改）' : 'sk-…'}
                autoComplete="off"
              />
            </Field>
          </div>

          <div className="grid-2">
            <Field label="文本模型" hint="用于批改、分析、文字版答题卡识别；可直接输入任意模型名">
              <ModelPicker
                value={textModel}
                onChange={setTextModel}
                options={modelOptions}
                placeholder="deepseek-flash"
              />
            </Field>
            <Field label="视觉模型" hint="下拉只列接口标了支持图片的模型；也可以手填">
              <ModelPicker
                value={visionModel}
                onChange={setVisionModel}
                options={modelOptions}
                placeholder="deepseek-flash"
                visionOnly
              />
            </Field>
          </div>

          <div className="row" style={{ gap: 10 }}>
            <button className="btn btn-sm" onClick={() => void fetchModels()} disabled={loadingModels || !baseURL.trim()}>
              {loadingModels ? <Spinner /> : <Icon name="refresh" size={14} />}
              获取可用模型
            </button>
            {modelList ? (
              <span className="hint">
                共 {modelList.length} 个模型，其中 <b>{modelList.filter((m) => m.vision).length}</b> 个支持图片；
                视觉模型下拉里只列这些
              </span>
            ) : (
              <span className="hint">填好 Base URL 和 Key 之后，可以直接从接口拉模型列表</span>
            )}
          </div>

          <div className="grid-2">
            <Field label="并发数" hint="同时请求模型的答题卡数量。限流报错时调小（1~6）">
              <input
                className="input"
                type="number"
                min={1}
                max={8}
                value={concurrency}
                onChange={(e) => setConcurrency(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
              />
            </Field>
            <Field label="JSON 模式" hint="要求模型返回严格 JSON，绝大多数服务支持">
              <label className="check" style={{ height: 34 }}>
                <input type="checkbox" checked={jsonMode} onChange={(e) => setJsonMode(e.target.checked)} />
                启用 response_format
              </label>
            </Field>
          </div>

          <div className="row">
            <button className="btn" onClick={test} disabled={testing}>
              {testing ? <Spinner /> : <Icon name="spark" size={15} />}
              测试连接
            </button>
            {preset?.docs && (
              <a className="hint" href={preset.docs} target="_blank" rel="noreferrer">
                服务商文档
              </a>
            )}
            {testResult && (
              <span className={`badge ${testResult.ok ? 'ok' : 'bad'}`} style={{ height: 'auto', padding: '4px 10px' }}>
                {testResult.text}
              </span>
            )}
          </div>


        </div>
      )}
    </Modal>
  );
}

export function ExamListPage({
  exams,
  loading,
  onOpen,
  onCreated,
}: {
  exams: ExamSummary[];
  loading: boolean;
  onOpen: (id: string) => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [grade, setGrade] = useState('');
  const [subject, setSubject] = useState('化学');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<ExamSummary | null>(null);

  const create = async () => {
    if (!name.trim()) {
      toast('请填写考试名称', 'bad');
      return;
    }
    setBusy(true);
    try {
      const exam = await api.createExam({ name: name.trim(), grade: grade.trim(), subject });
      setCreating(false);
      setName('');
      setGrade('');
      onCreated();
      onOpen(exam.id);
    } catch (err) {
      toast((err as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      await api.deleteExam(deleting.id);
      toast('已删除', 'ok');
      setDeleting(null);
      onCreated();
    } catch (err) {
      toast((err as Error).message, 'bad');
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>考试</h1>
          <div className="sub">建考试 → 录答案 → 传答题卡 → AI 批改 → 出成绩</div>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={16} />
          新建考试
        </button>
      </div>

      {loading ? (
        <div className="row" style={{ justifyContent: 'center', padding: 60 }}>
          <Spinner />
        </div>
      ) : exams.length === 0 ? (
        <div className="card">
          <div className="empty">
            <div className="icon-ring">
              <Icon name="flask" size={20} />
            </div>
            <h3>还没有考试</h3>
            <p>新建一场考试，按题目设置满分和参考答案，就可以上传答题卡让 AI 批改了。</p>
            <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={() => setCreating(true)}>
              <Icon name="plus" size={16} />
              新建考试
            </button>
          </div>
        </div>
      ) : (
        <div className="exam-grid">
          {exams.map((e) => {
            const pct = e.sheetCount ? Math.round((e.gradedCount / e.sheetCount) * 100) : 0;
            return (
              <div key={e.id} className="card exam-card" onClick={() => onOpen(e.id)}>
                <div className="row between" style={{ alignItems: 'flex-start' }}>
                  <h3>{e.name}</h3>
                  <button
                    className="icon-btn danger"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      setDeleting(e);
                    }}
                    title="删除考试"
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
                <div className="meta">
                  <span>
                    <Icon name="file" size={13} /> {e.questionCount} 题
                  </span>
                  <span>
                    <Icon name="users" size={13} /> {e.sheetCount} 份答题卡
                  </span>
                  {e.grade && <span>{e.grade}</span>}
                </div>
                <div className="bar">
                  <div className="progress">
                    <i style={{ width: `${pct}%` }} />
                  </div>
                  <span className="nowrap">
                    {e.gradedCount}/{e.sheetCount} 已批改
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal
        open={creating}
        title="新建考试"
        onClose={() => setCreating(false)}
        footer={
          <>
            <button className="btn" onClick={() => setCreating(false)}>
              取消
            </button>
            <button className="btn btn-primary" onClick={create} disabled={busy}>
              {busy ? <Spinner light /> : null}
              创建
            </button>
          </>
        }
      >
        <div className="stack">
          <Field label="考试名称">
            <input
              className="input"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：2026 年秋季期中考试"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void create();
              }}
            />
          </Field>
          <div className="grid-2">
            <Field label="学科" hint="影响 AI 的评分口径">
              <select className="select" value={subject} onChange={(e) => setSubject(e.target.value)}>
                {SUBJECTS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="班级 / 年级" optional hint="只用于展示">
              <input className="input" value={grade} onChange={(e) => setGrade(e.target.value)} placeholder="高二(3)班" />
            </Field>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!deleting}
        title="删除考试"
        onClose={() => setDeleting(null)}
        footer={
          <>
            <button className="btn" onClick={() => setDeleting(null)}>
              取消
            </button>
            <button className="btn btn-danger" onClick={remove}>
              删除
            </button>
          </>
        }
      >
        <p style={{ lineHeight: 1.8 }}>
          确定删除《{deleting?.name}》吗？该考试的题目、答题卡、作答和评分都会一并删除，且无法恢复。
        </p>
      </Modal>
    </div>
  );
}

export function ExamShell({
  exam,
  tab,
  onTab,
  onBack,
  children,
}: {
  exam: ExamDetail;
  tab: string;
  onTab: (t: string) => void;
  onBack: () => void;
  children: React.ReactNode;
}) {
  const reviewCount = collectReviewItems(exam).length;
  const tabs = [
    { id: 'questions', label: '试题', count: exam.questions.length },
    { id: 'sheets', label: '答题卡', count: exam.sheets.length },
    { id: 'grading', label: '批改', count: exam.gradedCount },
    { id: 'review', label: '复核', count: reviewCount },
    { id: 'report', label: '成绩', count: 0 },
  ];

  return (
    <div className="page">
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8, marginBottom: 6 }}>
            <button className="btn btn-ghost btn-sm" onClick={onBack}>
              <Icon name="chevron-left" size={13} />
              考试列表
            </button>
            {exam.grade && <span className="badge muted">{exam.grade}</span>}
          </div>
          <h1>{exam.name}</h1>
          <div className="sub">
            {exam.questions.length} 道题 · 满分 {exam.fullScore} 分 · {exam.sheets.length} 份答题卡 · 已批改{' '}
            {exam.gradedCount} 份
          </div>
        </div>
      </div>

      <div className="tabs">
        {tabs.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => onTab(t.id)}>
            {t.label}
            {t.count > 0 && <span className="count">{t.count}</span>}
          </button>
        ))}
      </div>

      {children}
    </div>
  );
}
