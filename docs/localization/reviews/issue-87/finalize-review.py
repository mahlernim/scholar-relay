import datetime, hashlib, json, pathlib, re
HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[3]
def read(name): return json.loads((HERE/name).read_text(encoding='utf-8'))
def write(name, value): (HERE/name).write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
def unwrap(name, key):
    raw=read(name); content=raw[key].strip()
    if content.startswith('```'): content=content.split('\n',1)[1].rsplit('```',1)[0].strip()
    return json.loads(content)
old=read('input-zh_CN.json')
opus=unwrap('opus-raw.json','result'); gemini=unwrap('gemini-raw.json','response')
osup=unwrap('opus-supplement-raw.json','result'); gsup=unwrap('gemini-supplement-raw.json','response')
for name, proposal in [('opus',opus),('gemini',gemini)]:
    assert set(proposal['translations'])==set(old)
    assert set(proposal['rationale'])==set(old)
    write(name+'-proposal.json',proposal)
for name, proposal in [('opus',osup),('gemini',gsup)]: write(name+'-supplement-proposal.json',proposal)
final={**opus['translations'], **osup['translations']}
overrides={
 'Kawaii': ('可爱','Use the later directly observed Simplified Chinese product label.'),
 'Clay': ('泥塑风','Use the later directly observed style label, not a literal material noun.'),
 'Editorial': ('编辑风','Use the later directly observed style label rather than either unverified proposal.'),
 'Instructional': ('教学风','Use the later directly observed style label.'),
 'Bento Grid': ('Bento 网格','Use the later directly observed mixed-script style label.'),
 'Scientific': ('科学','Use the later directly observed product label.'),
 'Concise': ('简短','Use the later directly observed infographic detail label. This key is only used for infographic detail.'),
 'Auto': ('自动选择','Use the directly observed automatic style-selection label for this layout preset.'),
 'Ready': ('就绪','Retain the established compact phase label. Completion eligibility is controlled by the existing state logic.'),
 'Article PDF': ('论文 PDF','The detected document is an academic paper, not a generic web article.'),
 'Use paper title for notebook': ('使用论文标题命名笔记本','Gemini gives a shorter natural toggle label with the same naming behavior.'),
 'Length': ('长度','Shared audio and slide key. Both supplements recommend a generic label instead of audio-only 时长.'),
 'Presenter': ('演示用','Use the compact form of verified 演示用幻灯片 for the slide format option. The longer exact term is unnecessary under the deck heading.'),
 'Custom visual style prompt': ('自定义视觉风格提示词','Gemini names a model prompt precisely rather than a generic UI hint.'),
 'Time queued': ('排队时长','The existing clock displays elapsed queue duration, not the timestamp suggested by Opus.'),
 'Some requests failed. Check this notebook for details.': ('有请求失败。请在此笔记本中查看详情。','Retain the reviewed #105 wording. It covers one or more failures including all-failed requests without implying successful siblings.'),
 'Gemini Notebook Ready!': ('Gemini Notebook 已就绪！','Gemini avoids repeating notebook after the product name.'),
 'Action needed': ('待处理','Gemini is concise and correctly signals required attention without asserting a cause.'),
 'Waiting for you': ('等待操作','Gemini removes an unnecessary pronoun while preserving the user-action blocker.'),
 'Limit': ('受限','Retain the established compact advisory suffix. It denotes a limited action rather than just naming a numerical upper limit.'),
 'Deletion needs checking': ('删除结果待确认','Gemini explicitly preserves uncertainty about deletion and is more compact.'),
 'Papers on this page': ('本页论文','Gemini gives the compact equivalent for the paper-list heading.'),
 'Clear': ('取消全选','Retain the established selection control. This deselects papers and does not delete data.'),
 'One notebook': ('一个笔记本','Retain the compact grouping choice and avoid redundant explanation.'),
 'One per paper': ('每篇一个','Retain the compact paired grouping choice under the notebook controls.'),
 'Compute window resets $1.': ('计算用量窗口于 $1 重置。','Retain the existing precise reset statement. The placeholder remains an advisory time, not a retry command.'),
 'Sends tab text to Google as a text source. May include sign-in-only content.': ('将标签页正文作为文本来源发送给 Google，可能包含仅登录后可见的内容。','Retain the existing consent wording also proposed by Gemini. It preserves the recipient and the possibility of login-only content.'),
 'Wait for the queue to resume or finish preparing another job.': ('请等待队列恢复或另一项任务准备完成。','Retain the concise existing instruction also proposed by Gemini, preserving both alternatives.'),
 '$1 of $2 artifacts ready.': ('$1/$2 项学习资料已就绪。','Combine Gemini compact count order with the consistent item classifier 项. Both placeholders keep their original roles.'),
 'Delete this notebook from Gemini Notebook? This cannot be undone.': ('要从 Gemini Notebook 中删除此笔记本吗？此操作无法撤销。','Keep the explicit destructive confirmation and irreversibility, using standard 撤销 spelling.'),
 'Starting...': ('正在启动…','Use the more natural startup verb from Gemini with the consistent single ellipsis.'),
 '⏳ Starting...': ('⏳ 正在启动…','Use the same startup verb and preserve the source icon.'),
 'Elapsed time: $1 min.': ('已用时间 $1 分钟。','Translate the unit and preserve elapsed duration with simple punctuation.'),
 'Collections available: $1.': ('可用集合 $1 个。','Use the consistent collection noun and a natural count with simple punctuation.'),
 'Artifacts ready: $1!': ('$1 项学习资料已就绪！','Natural Chinese count order keeps the ready total and consistent item classifier.'),
}
for key,(value,reason) in overrides.items(): final[key]=value
for key in final: final[key]=final[key].replace('此弹出窗口','此弹窗')
decisions=[]
for key,value in final.items():
    a=opus if key in old else osup; b=gemini if key in old else gsup
    reason=overrides[key][1] if key in overrides else 'Accept the Opus wording after comparing both independent proposals. '+a['rationale'][key]
    if '此弹窗' in value: reason+=' Shorten 弹出窗口 to 弹窗 consistently without changing the keep-open condition.'
    if key not in old: reason='Both independent supplements agree. The noun labels the returned count without asserting readiness or import success.'
    if '集合' in value: reason+=' Keep 集合 consistent with existing store copy. This is extension terminology, not a directly verified Google UI label.'
    assert sorted(re.findall(r'\$\d+',key))==sorted(re.findall(r'\$\d+',value)), key
    assert '\u2014' not in value, key
    for icon in ['⚠️','📓','🎨','🎧','🎬','📄','❓','🃏','🖼','📊','🧠','📋','✨','⏳']:
        if icon in key: assert icon in value,key
    decisions.append(dict(source=key, previous=old.get(key), opus=a['translations'][key], gemini=b['translations'][key], final=value, decision='retained' if old.get(key)==value else 'updated' if key in old else 'added', rationale=reason))
(ROOT/'docs/localization/zh_CN.json').write_text(json.dumps(final,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
for name in ['opus','gemini']:
    for suffix in ['', '-supplement']:
        provenance=read(name+suffix+'-provenance.json'); raw=read(name+suffix+'-raw.json')
        provenance['response_reported_model']=list(raw.get('modelUsage',{})) or None
        provenance['raw_reply_sha256']=hashlib.sha256((HERE/(name+suffix+'-raw.json')).read_bytes()).hexdigest()
        provenance['tools_policy']='No tools, strict MCP config, no session persistence' if name=='opus' else 'Explicit no-tools prompt instruction. CLI warned that requested plan mode had no effect with slash command expansion disabled.'
        write(name+suffix+'-provenance.json',provenance)
files=['input-zh_CN.json','prompt.txt','supplement-prompt.txt','terminology-evidence.txt','opus-raw.json','gemini-raw.json','opus-supplement-raw.json','gemini-supplement-raw.json']
record=dict(issue=87,reviewer_model='gpt-6-astra',reviewed_at_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),hash_scope='SHA-256 of exact UTF-8 file bytes',files={f:hashlib.sha256((HERE/f).read_bytes()).hexdigest() for f in files},final_catalog_sha256=hashlib.sha256((ROOT/'docs/localization/zh_CN.json').read_bytes()).hexdigest(),original_key_count=len(old),final_key_count=len(final),changed_existing=sum(old.get(k)!=v for k,v in final.items() if k in old),decisions=decisions)
write('final-decisions.json',record)
print(json.dumps({k:record[k] for k in ['original_key_count','final_key_count','changed_existing']},indent=2))
