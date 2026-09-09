'use strict';

const obsidian = require('obsidian');
const Plugin = obsidian.Plugin;
const PluginSettingTab = obsidian.PluginSettingTab;
const Setting = obsidian.Setting;
const Notice = obsidian.Notice;
const Modal = obsidian.Modal;
const MarkdownView = obsidian.MarkdownView;
const normalizePath = obsidian.normalizePath;

const momentLib = obsidian.moment || window.moment;

const DEFAULT_SETTINGS = {
	// 留空 = 自动读取 Obsidian「日记」核心插件里的设置，装到别人库里也能直接用
	diaryFolder: '',
	dateFormat: '',
	entryHeading: '',
	entryFormat: '- {time} ',
	lockPast: true,
	protectFrontmatter: true,
	confirmUnlock: true,
	lockHint: true,
	statusBar: true,
};

const FALLBACK_DATE_FORMAT = 'YYYY-MM-DD';

/* ------------------------------------------------------------------ */
/* 确认框                                                              */
/* ------------------------------------------------------------------ */

class ConfirmModal extends Modal {
	constructor(app, opts) {
		super(app);
		this.opts = opts || {};
		this.done = false;
	}

	onOpen() {
		const el = this.contentEl;
		el.empty();
		el.createEl('h3', { text: this.opts.title || '确认' });
		el.createEl('p', { text: this.opts.body || '', cls: 'diary-lock-body' });
		const row = el.createDiv({ cls: 'diary-lock-row' });
		const cancel = row.createEl('button', { text: '取消' });
		cancel.onclick = () => this.finish(false);
		const ok = row.createEl('button', {
			text: this.opts.cta || '确定',
			cls: 'mod-cta',
		});
		ok.onclick = () => this.finish(true);
	}

	finish(value) {
		if (this.done) return;
		this.done = true;
		this.close();
		if (typeof this.opts.onResolve === 'function') this.opts.onResolve(value);
	}

	onClose() {
		this.contentEl.empty();
		if (!this.done) {
			this.done = true;
			if (typeof this.opts.onResolve === 'function') this.opts.onResolve(false);
		}
	}
}

/* ------------------------------------------------------------------ */
/* 追加一条                                                            */
/* ------------------------------------------------------------------ */

class AppendEntryModal extends Modal {
	constructor(app, plugin, file) {
		super(app);
		this.plugin = plugin;
		this.file = file;
	}

	onOpen() {
		const el = this.contentEl;
		el.empty();
		el.createEl('h3', { text: '追加到 ' + this.file.basename });
		el.createEl('p', {
			text: '只会写在「日志」最后一条之后，不会改动任何已有内容。Ctrl+Enter 提交。',
			cls: 'diary-lock-body',
		});

		const ta = el.createEl('textarea', { cls: 'diary-lock-input' });
		this.ta = ta;
		ta.placeholder = '现在发生了什么……';
		ta.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				this.submit();
			}
		});

		const row = el.createDiv({ cls: 'diary-lock-row' });
		const cancel = row.createEl('button', { text: '取消' });
		cancel.onclick = () => this.close();
		const ok = row.createEl('button', { text: '追加', cls: 'mod-cta' });
		ok.onclick = () => this.submit();

		setTimeout(() => ta.focus(), 0);
	}

	submit() {
		const text = this.ta ? this.ta.value : '';
		if (!text || !text.trim()) {
			new Notice('内容为空，没有写入');
			return;
		}
		this.close();
		this.plugin.appendEntry(this.file, text);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/* ------------------------------------------------------------------ */
/* 插件主体                                                            */
/* ------------------------------------------------------------------ */

class DiaryLockPlugin extends Plugin {
	async onload() {
		await this.loadSettings();

		this.unlocked = new WeakMap();
		this.fixing = new Set();
		this.enforcing = false;
		this.prompting = false;
		this.timer = null;
		this.timer2 = null;
		this.lastMode = new WeakMap();
		this.openedAt = new WeakMap();
		this.notified = new Set();
		this.snapshots = new Map();
		this.recentUnlock = new Map();

		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass('diary-lock-status');
		this.statusEl.style.cursor = 'pointer';
		this.statusEl.style.display = 'none';
		this.registerDomEvent(this.statusEl, 'click', () => {
			this.toggleLockCurrent();
		});

		this.registerEvent(
			this.app.workspace.on('file-open', (file) => {
				if (file) this.markOpened(file);
				this.queue();
			})
		);
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				this.queue();
				this.refreshStatus();
			})
		);
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => this.refreshStatus())
		);
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				this.guardFrontmatter(file);
			})
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				this.onFileDeleted(file);
			})
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				this.onFileRenamed(file, oldPath);
			})
		);

		this.addRibbonIcon('pencil', '追加一条日记', () => {
			this.openAppendForCurrent();
		});
		// 手机上没有状态栏，给一个能点到锁的入口
		this.addRibbonIcon('lock', '锁定 / 解锁当前日记', () => {
			this.toggleLockCurrent();
		});

		// 第二道拦截：不依赖 layout-change，直接吃掉锁定日记里的 Ctrl/Cmd+E
		if (typeof document !== 'undefined') {
			this.registerDomEvent(document, 'keydown', (e) => {
				this.onKeyDown(e);
			});
		}

		this.addCommand({
			id: 'toggle-lock',
			name: '锁定 / 解锁当前日记',
			callback: () => this.toggleLockCurrent(),
		});
		this.addCommand({
			id: 'append-entry',
			name: '追加一条日记',
			callback: () => this.openAppendForCurrent(),
		});
		this.addCommand({
			id: 'relock-all',
			name: '全部重新锁定',
			callback: () => this.relockAll(),
		});

		this.addSettingTab(new DiaryLockSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			this.queue();
			this.refreshStatus();
		});
	}

	onunload() {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.timer2) {
			clearTimeout(this.timer2);
			this.timer2 = null;
		}
		const leaves = this.app.workspace.getLeavesOfType('markdown');
		for (let i = 0; i < leaves.length; i++) {
			this.markLockedView(leaves[i].view, false);
		}
	}

	async loadSettings() {
		const saved = await this.loadData();
		const merged = Object.assign({}, DEFAULT_SETTINGS, saved || {});
		// 旧版本叫 protectDate，平滑迁移
		if (
			saved &&
			typeof saved.protectFrontmatter === 'undefined' &&
			typeof saved.protectDate === 'boolean'
		) {
			merged.protectFrontmatter = saved.protectDate;
		}
		if (Object.prototype.hasOwnProperty.call(merged, 'protectDate')) {
			delete merged.protectDate;
		}
		this.settings = merged;
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.queue();
		this.refreshStatus();
	}

	dailyNotesOptions() {
		try {
			const plugins = this.app.internalPlugins;
			const dn =
				plugins && typeof plugins.getPluginById === 'function'
					? plugins.getPluginById('daily-notes')
					: null;
			const opts = dn && dn.instance && dn.instance.options;
			if (!opts) return null;
			return {
				folder: typeof opts.folder === 'string' ? opts.folder : '',
				format:
					typeof opts.format === 'string' && opts.format
						? opts.format
						: FALLBACK_DATE_FORMAT,
			};
		} catch (e) {
			return null;
		}
	}

	diaryConfig() {
		const dn = this.dailyNotesOptions();
		const rawFolder = (this.settings.diaryFolder || '').trim();
		const rawFormat = (this.settings.dateFormat || '').trim();
		const folder = rawFolder || (dn ? dn.folder : '');
		const format = rawFormat || (dn ? dn.format : FALLBACK_DATE_FORMAT);
		return {
			folder: folder
				? normalizePath(folder.replace(/^\/+/, '')).replace(/\/+$/, '')
				: '',
			format: format,
		};
	}

	// 去掉日记文件夹前缀和 .md 之后剩下的那一段，例如 2026/11/2026-11-02
	diaryKey(file) {
		if (!file) return null;
		const folder = this.diaryConfig().folder;
		const path = file.path;
		if (folder) {
			if (path !== folder && path.indexOf(folder + '/') !== 0) return null;
			return path.slice(folder.length + 1).replace(/\.md$/i, '');
		}
		return path.replace(/\.md$/i, '');
	}

	isDiaryFile(file) {
		if (!file || file.extension !== 'md') return false;
		const key = this.diaryKey(file);
		if (!key) return false;
		const format = this.diaryConfig().format;
		const parsed = momentLib(key, format, true);
		if (!parsed || !parsed.isValid()) return false;
		// 再按同一格式格式化回去逐字比对。格式里有重复 token（比如 YYYY/MM/YYYY-MM-DD）
		// 时解析结果未必可信，round-trip 才能确定这个路径确实是那一天
		if (typeof parsed.format !== 'function') return true;
		return parsed.format(format) === key;
	}

	todayKey() {
		return momentLib().format(this.diaryConfig().format);
	}

	shouldLock(file) {
		if (!this.settings.lockPast) return false;
		if (!this.isDiaryFile(file)) return false;
		return this.diaryKey(file) !== this.todayKey();
	}

	isUnlocked(leaf, file) {
		return this.unlocked.get(leaf) === file.path;
	}

	modeOf(view) {
		if (!view) return null;
		if (typeof view.getMode === 'function') return view.getMode();
		const state = view.getState ? view.getState() : null;
		return state ? state.mode : null;
	}

	setMode(view, mode) {
		if (!view || typeof view.getState !== 'function') return;
		const state = view.getState();
		if (!state || state.mode === mode) return;
		const next = Object.assign({}, state, { mode: mode });
		view.setState(next, { history: false });
	}

	async writeFile(file, mutator) {
		if (typeof this.app.vault.process === 'function') {
			await this.app.vault.process(file, mutator);
			return;
		}
		const data = await this.app.vault.read(file);
		const next = mutator(data);
		if (next !== data) await this.app.vault.modify(file, next);
	}

	queue() {
		if (this.timer || this.timer2) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.applyLocks();
		}, 0);
		// 打开文件的瞬间视图状态可能还没落定，补一次，免得锁漏掉
		this.timer2 = setTimeout(() => {
			this.timer2 = null;
			this.applyLocks();
		}, 180);
	}

	applyLocks() {
		if (this.enforcing) return;
		this.enforcing = true;
		try {
			const leaves = this.app.workspace.getLeavesOfType('markdown');

			for (let i = 0; i < leaves.length; i++) {
				const leaf = leaves[i];
				try {
					const view = leaf.view;
					const file = view ? view.file : null;
					if (!file) continue;

					const locked = this.shouldLock(file) && !this.isUnlocked(leaf, file);
					this.markLockedView(view, locked);
					if (!locked) continue;
					this.ensureSnapshot(file);

					const mode = this.modeOf(view);
					if (mode === 'preview') {
						this.lastMode.set(leaf, 'preview');
						continue;
					}

					// 先退回阅读视图：任何时候都不留出可编辑的窗口
					this.setMode(view, 'preview');

					// 只有"本来就在阅读视图、被切回编辑"才算用户主动动手；
					// 打开笔记时恢复成编辑模式的那一下静默处理，不打扰
					const wasPreview = this.lastMode.get(leaf) === 'preview';
					this.lastMode.set(leaf, 'preview');
					const openedAt = this.openedAt.get(leaf) || 0;
					if (wasPreview && Date.now() - openedAt > 700) {
						this.hintLocked(file);
					}
				} catch (e) {
					console.error('[日记锁] 处理标签页失败', e);
				}
			}

			this.refreshStatus();
		} finally {
			this.enforcing = false;
		}
	}

	markOpened(file) {
		const leaves = this.app.workspace.getLeavesOfType('markdown');
		for (let i = 0; i < leaves.length; i++) {
			const view = leaves[i].view;
			if (view && view.file && view.file.path === file.path) {
				this.openedAt.set(leaves[i], Date.now());
			}
		}
	}

	onFileDeleted(file) {
		if (!file) return;
		this.snapshots.delete(file.path);
		this.notified.delete(file.path);
		this.recentUnlock.delete(file.path);
	}

	onFileRenamed(file, oldPath) {
		if (!file) return;
		if (this.snapshots.has(oldPath)) {
			const snap = this.snapshots.get(oldPath);
			this.snapshots.delete(oldPath);
			this.snapshots.set(file.path, snap);
		}
		this.notified.delete(oldPath);
		this.recentUnlock.delete(oldPath);
	}

	onKeyDown(e) {
		if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
		if (e.key !== 'e' && e.key !== 'E') return;

		const target = e.target;
		if (
			target &&
			(target.tagName === 'INPUT' ||
				target.tagName === 'TEXTAREA' ||
				target.isContentEditable)
		) {
			return;
		}

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const file = view ? view.file : null;
		if (!file || !this.shouldLock(file)) return;
		if (this.isUnlocked(view.leaf, file)) return;

		e.preventDefault();
		e.stopPropagation();
		this.hintLocked(file);
		this.queue();
	}

	hintLocked(file) {
		if (!this.settings.lockHint) return;
		if (this.notified.has(file.path)) return;
		this.notified.add(file.path);
		new Notice(
			'这篇日记已锁定（' +
				file.basename +
				'）。想改的话点右下角 🔒 解锁编辑；只想补一句就用「追加一条日记」',
			4000
		);
	}

	/* ---------------- 属性（frontmatter）保护 ---------------- */

	rawFrontmatter(data) {
		const m = data.match(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---/);
		return m ? m[0] : null;
	}

	isOpenUnlocked(path) {
		const leaves = this.app.workspace.getLeavesOfType('markdown');
		for (let i = 0; i < leaves.length; i++) {
			const view = leaves[i].view;
			if (view && view.file && view.file.path === path) {
				if (this.unlocked.get(leaves[i]) === path) return true;
			}
		}
		return false;
	}

	markLockedView(view, locked) {
		const el = view ? view.containerEl : null;
		if (!el || !el.classList) return;
		if (locked) el.classList.add('diary-lock-locked');
		else el.classList.remove('diary-lock-locked');
	}

	async ensureSnapshot(file) {
		if (!this.settings.protectFrontmatter) return;
		if (!file || !this.isDiaryFile(file)) return;
		if (this.snapshots.has(file.path)) return;
		let data;
		try {
			data = await this.app.vault.read(file);
		} catch (e) {
			return;
		}
		if (this.snapshots.has(file.path)) return;
		this.snapshots.set(file.path, this.rawFrontmatter(data));
	}

	async guardFrontmatter(file) {
		if (!this.settings.protectFrontmatter) return;
		if (!this.isDiaryFile(file)) return;
		if (!this.shouldLock(file)) return;
		if (this.fixing.has(file.path)) return;

		let data;
		try {
			// 不用 cachedRead：缓存可能是改动前的旧内容，会让保护静默失效
			data = await this.app.vault.read(file);
		} catch (e) {
			return;
		}

		const current = this.rawFrontmatter(data);

		// 已解锁的笔记不干预，只把基准更新成当前状态
		if (this.isOpenUnlocked(file.path)) {
			this.snapshots.set(file.path, current);
			this.recentUnlock.set(file.path, Date.now());
			return;
		}

		if (!this.snapshots.has(file.path)) {
			this.snapshots.set(file.path, current);
			return;
		}

		const expected = this.snapshots.get(file.path);
		if (current === expected) return;

		// 刚解锁过（比如解锁编辑后关掉标签页才落盘），放行这一次
		const recent = this.recentUnlock.get(file.path) || 0;
		if (Date.now() - recent < 3000) {
			this.snapshots.set(file.path, current);
			return;
		}

		// 原本就没有属性块：不主动删别人加的东西，只更新基准
		if (expected === null) {
			this.snapshots.set(file.path, current);
			return;
		}

		let body;
		if (current === null) {
			if (!data) {
				body = '';
			} else {
				const eol = data.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
				const first = data.charAt(0);
				body = first === '\n' || first === '\r' ? data : eol + data;
			}
		} else {
			body = data.slice(current.length);
		}

		const next = expected + body;
		if (next === data) return;

		this.fixing.add(file.path);
		try {
			await this.writeFile(file, () => next);
			new Notice('这篇日记的属性已锁定，改动已还原', 5000);
		} catch (e) {
			console.error('[日记锁] 还原属性失败', e);
		} finally {
			const path = file.path;
			setTimeout(() => this.fixing.delete(path), 1500);
		}
	}

	promptUnlock(view) {
		const file = view.file;
		if (!file) return;
		if (this.prompting) return;

		if (!this.settings.confirmUnlock) {
			this.unlocked.set(view.leaf, file.path);
			this.setMode(view, 'source');
			this.refreshStatus();
			return;
		}

		this.prompting = true;
		try {
			const modal = new ConfirmModal(this.app, {
				title: '这篇日记已锁定',
				body:
					file.basename +
					' 是过去的日记。修改会改变它的内容和文件时间，确定要解锁编辑吗？',
				cta: '解锁编辑',
				onResolve: (ok) => {
					this.prompting = false;
					if (ok) {
						this.unlocked.set(view.leaf, file.path);
						this.setMode(view, 'source');
						new Notice('已解锁：仅当前标签页有效，切走或关闭标签页后重新锁定');
					} else {
						this.setMode(view, 'preview');
					}
					this.refreshStatus();
				},
			});
			modal.open();
		} catch (e) {
			this.prompting = false;
			console.error('[日记锁] 打开确认框失败', e);
			this.setMode(view, 'preview');
		}
	}

	relockAll() {
		this.unlocked = new WeakMap();
		this.notified.clear();
		this.applyLocks();
		this.refreshStatus();
		new Notice('全部日记已重新锁定');
	}

	toggleLockCurrent() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const file = view ? view.file : null;
		if (!file || !this.isDiaryFile(file)) {
			new Notice('当前笔记不是日记');
			return;
		}
		if (!this.shouldLock(file)) {
			new Notice('今天的日记不需要锁定');
			return;
		}
		if (this.isUnlocked(view.leaf, file)) {
			this.unlocked.delete(view.leaf);
			this.setMode(view, 'preview');
			this.refreshStatus();
			new Notice('已重新锁定');
		} else {
			this.promptUnlock(view);
		}
	}

	refreshStatus() {
		const el = this.statusEl;
		if (!el) return;
		if (!this.settings.statusBar) {
			el.style.display = 'none';
			return;
		}
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const file = view ? view.file : null;
		if (!file || !this.isDiaryFile(file)) {
			el.style.display = 'none';
			return;
		}

		el.style.display = '';
		if (!this.shouldLock(file)) {
			el.setText('📝 今日日记');
			el.title = '今天的日记可以直接编辑';
			return;
		}
		if (this.isUnlocked(view.leaf, file)) {
			el.setText('🔓 已解锁');
			el.title = '点击重新锁定';
		} else {
			el.setText('🔒 已锁定');
			el.title = '点击解锁编辑（会二次确认）';
		}
	}

	openAppendForCurrent() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const file = view ? view.file : null;
		if (!file) {
			new Notice('请先打开一篇笔记');
			return;
		}
		if (!this.isDiaryFile(file)) {
			new Notice('当前笔记不是日记，无法追加');
			return;
		}
		new AppendEntryModal(this.app, this, file).open();
	}

	async appendEntry(file, rawText) {
		const text = String(rawText || '')
			.replace(/^[\s\uFEFF]+/, '')
			.replace(/\s+$/, '');
		if (!text.trim()) {
			new Notice('内容为空，没有写入');
			return;
		}
		const stamp = momentLib().format('HH:mm');
		const lines = text.split(/\r?\n/);
		try {
			await this.writeFile(file, (data) => {
				return this.insertEntry(data, lines, stamp);
			});
			new Notice('已追加到 ' + file.basename);
		} catch (e) {
			console.error('[日记锁] 追加失败', e);
			new Notice('追加失败，详情见控制台');
		}
	}

	insertEntry(data, lines, stamp) {
		const eol = data.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
		const arr = data.split(/\r?\n/);
		const heading = (this.settings.entryHeading || '').trim();

		let headingIdx = -1;
		if (heading) {
			for (let i = 0; i < arr.length; i++) {
				if (arr[i].trim() === heading) {
					headingIdx = i;
					break;
				}
			}
		}

		const prefix = (this.settings.entryFormat || '- {time} ')
			.replace(/[\r\n]+/g, ' ')
			.split('{time}')
			.join(stamp);

		const block = [];
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].replace(/\s+$/, '');
			if (i === 0) {
				let body = line.trim();
				if (body.indexOf('- ') === 0) body = body.slice(2);
				block.push(prefix + body);
			} else if (line.trim() === '') {
				block.push('');
			} else {
				block.push('  ' + line);
			}
		}

		let insertAfter;
		if (headingIdx === -1) {
			insertAfter = -1;
			for (let i = 0; i < arr.length; i++) {
				if (arr[i].trim() !== '') insertAfter = i;
			}
			if (insertAfter < 0) {
				// 空文件：不要在开头多留一个空行
				return block.join(eol) + eol;
			}
		} else {
			let end = arr.length;
			for (let i = headingIdx + 1; i < arr.length; i++) {
				if (/^#{1,2}\s/.test(arr[i])) {
					end = i;
					break;
				}
			}
			insertAfter = headingIdx;
			for (let i = headingIdx + 1; i < end; i++) {
				if (arr[i].trim() !== '') insertAfter = i;
			}
		}

		const out = arr
			.slice(0, insertAfter + 1)
			.concat(block)
			.concat(arr.slice(insertAfter + 1));
		return out.join(eol);
	}
}

class DiaryLockSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const el = this.containerEl;
		el.empty();
		el.createEl('h2', { text: '日记锁' });
		el.createEl('p', {
			text:
				'日记文件夹和日期格式默认跟随 Obsidian 自带的「日记」核心插件，一般不用填。' +
				'笔记路径去掉文件夹和 .md 之后，能按日期格式解析出来（比如 2026-11-02、2026/11/2026-11-02），' +
				'并且不是今天，就算过去的日记。',
			cls: 'diary-lock-body',
		});

		new Setting(el)
			.setName('日记文件夹')
			.setDesc('留空 = 用「日记」核心插件里设置的文件夹。')
			.addText((t) =>
				t
					.setPlaceholder('留空自动读取')
					.setValue(this.plugin.settings.diaryFolder)
					.onChange(async (v) => {
						this.plugin.settings.diaryFolder = v.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(el)
			.setName('日期格式')
			.setDesc('留空 = 用「日记」核心插件里设置的格式。可填 YYYY-MM-DD、YYYY/MM/DD、YYYY/MM/YYYY-MM-DD 等。')
			.addText((t) =>
				t
					.setPlaceholder('留空自动读取')
					.setValue(this.plugin.settings.dateFormat)
					.onChange(async (v) => {
						this.plugin.settings.dateFormat = v.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(el)
			.setName('锁定过去的日记')
			.setDesc('关闭后完全不干预，只保留「追加一条」命令。')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.lockPast).onChange(async (v) => {
					this.plugin.settings.lockPast = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(el)
			.setName('解锁时二次确认')
			.setDesc('点状态栏的锁、或执行「锁定 / 解锁当前日记」时才弹框确认。打开笔记不会弹。')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.confirmUnlock).onChange(async (v) => {
					this.plugin.settings.confirmUnlock = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(el)
			.setName('尝试编辑时提示一次')
			.setDesc('锁定的日记里点铅笔或按 Ctrl+E 时，用一条短提示说明怎么解锁；每篇只提示一次，之后静默退回阅读视图。')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.lockHint).onChange(async (v) => {
					this.plugin.settings.lockHint = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(el)
			.setName('保护笔记属性')
			.setDesc('锁定的日记里，改 frontmatter（date、tags、weather、睡眠 等）会被还原；只有解锁后才能改。阅读视图里的「属性」块也会被禁用，点不动。')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.protectFrontmatter).onChange(async (v) => {
					this.plugin.settings.protectFrontmatter = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(el)
			.setName('状态栏图标')
			.setDesc('在右下角显示 🔒 / 🔓，点击可锁定或解锁。')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.statusBar).onChange(async (v) => {
					this.plugin.settings.statusBar = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(el)
			.setName('追加位置标题')
			.setDesc('「追加一条」插到这个标题所在小节的末尾。留空 = 直接追加到文末，不挑标题。')
			.addText((t) =>
				t
					.setPlaceholder('留空 = 追加到文末')
					.setValue(this.plugin.settings.entryHeading)
					.onChange(async (v) => {
						this.plugin.settings.entryHeading = v.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(el)
			.setName('追加条目格式')
			.setDesc('{time} 会替换成当前时间。默认 "- {time} " 得到「- 08:30 内容」。')
			.addText((t) =>
				t
					.setPlaceholder('- {time} ')
					.setValue(this.plugin.settings.entryFormat)
					.onChange(async (v) => {
						this.plugin.settings.entryFormat = v;
						await this.plugin.saveSettings();
					})
			);
	}
}

module.exports = DiaryLockPlugin;
