//! Backend do CleanNotes: guarda projetos e abas como arquivos no disco.
//!
//!   <pasta das notas>/workspace.json                  projetos, abas, lixeira e estado da interface (v2)
//!   <pasta das notas>/<slug-da-aba>.md                 abas sem projeto
//!   <pasta das notas>/<slug-do-projeto>/<slug>.md      abas de um projeto
//!   <pasta das notas>/.lixeira/<data>-<slug>.md        abas fechadas, restauráveis
//!
//! A pasta das notas é <app data>/workspace, ou a escolhida pelo usuário em
//! <app config>/config.json (junto com o atalho global). O estado fica num Mutex
//! (AppState); cada comando altera o índice em memória, mexe nos arquivos e
//! regrava o workspace.json de forma atômica.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, State};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const PALETTE: [&str; 9] = [
    "azul", "verde", "laranja", "roxo", "rosa", "ciano", "amarelo", "vermelho", "cinza",
];
const VIEW_MODES: [&str; 3] = ["editor", "split", "preview"];
const MAX_NAME: usize = 60;
const MAX_SLUG: usize = 60;
const VERSION: u32 = 2;
const TRASH_DIR: &str = ".lixeira";
const DEFAULT_SHORTCUT: &str = "CommandOrControl+Shift+Space";
const MAX_IMPORT_BYTES: u64 = 5 * 1024 * 1024;
const SECRET_SERVICE: &str = "dev.cleandev.cleannotes";
/// O Credential Manager do Windows aceita ~1280 caracteres por credencial.
const MAX_SECRET_CHARS: usize = 1000;
const DUP_TAB: &str = "Já existe uma aba com esse nome neste projeto.";
const DUP_PROJECT: &str = "Já existe um projeto com esse nome.";

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Project {
    id: String,
    name: String,
    color: String,
    folder: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct TabMeta {
    id: String,
    name: String,
    #[serde(rename = "projectId", default)]
    project_id: Option<String>,
    file: String,
}

fn default_filter() -> String {
    "all".into()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Ui {
    #[serde(default)]
    active: Option<String>,
    #[serde(rename = "viewMode", default)]
    view_mode: Option<String>,
    #[serde(default = "default_filter")]
    filter: String,
    #[serde(rename = "lastActive", default)]
    last_active: HashMap<String, String>,
    /// ambiente de variáveis ativo
    #[serde(default)]
    env: Option<String>,
}

impl Default for Ui {
    fn default() -> Self {
        Ui { active: None, view_mode: None, filter: default_filter(), last_active: HashMap::new(), env: None }
    }
}

/// Aba fechada: o arquivo fica em .lixeira/ até ser restaurado ou a lixeira ser esvaziada.
#[derive(Serialize, Deserialize, Clone, Debug)]
struct TrashItem {
    id: String,
    name: String,
    #[serde(rename = "projectId", default)]
    project_id: Option<String>,
    #[serde(rename = "projectName", default)]
    project_name: Option<String>,
    #[serde(rename = "projectColor", default)]
    project_color: Option<String>,
    /// segundos desde 1970 (UTC)
    #[serde(rename = "deletedAt", default)]
    deleted_at: u64,
    /// nome do arquivo dentro de .lixeira/
    file: String,
}

/// Variável de ambiente, como no Postman: `{{chave}}` no texto vira o valor ao copiar.
#[derive(Serialize, Deserialize, Clone, Debug)]
struct Variable {
    key: String,
    #[serde(default)]
    value: String,
    #[serde(default)]
    description: String,
    /// Segredo: o valor mora no cofre do sistema e nunca vai para o workspace.json.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    secret: bool,
    /// Só na ida para o front: o cofre não pôde ser lido; o valor real continua intacto lá.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    locked: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Environment {
    id: String,
    name: String,
    #[serde(default)]
    variables: Vec<Variable>,
}

#[derive(Serialize, Deserialize)]
struct Index {
    version: u32,
    projects: Vec<Project>,
    tabs: Vec<TabMeta>,
    #[serde(default)]
    trash: Vec<TrashItem>,
    #[serde(default)]
    environments: Vec<Environment>,
    ui: Ui,
}

impl Index {
    fn empty() -> Index {
        Index { version: VERSION, projects: vec![], tabs: vec![], trash: vec![], environments: vec![], ui: Ui::default() }
    }
}

#[derive(Serialize)]
struct TabOut {
    #[serde(flatten)]
    meta: TabMeta,
    content: String,
}

#[derive(Serialize)]
struct Workspace {
    projects: Vec<Project>,
    tabs: Vec<TabOut>,
    environments: Vec<Environment>,
    ui: Ui,
    dir: String,
}

#[derive(Serialize, Debug)]
struct DeleteResult {
    /// idAba -> novo caminho
    files: HashMap<String, String>,
    /// idAba -> novo nome (só as abas renomeadas por colisão em "Sem projeto")
    names: HashMap<String, String>,
    filter: String,
}

fn err<E: ToString>(e: E) -> String {
    e.to_string()
}

/// Os ids viram nomes de campo e de mapa, então só aceitamos caracteres seguros.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn valid_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= MAX_SLUG + 8
        && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Arquivo dentro de .lixeira/: um único componente, só [a-z0-9_-].
fn valid_trash_file(f: &str) -> bool {
    f.strip_suffix(".md").map_or(false, |s| {
        !s.is_empty() && s.len() <= 120 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
    })
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Data (civil, UTC) a partir de dias desde 1970 — algoritmo de Howard Hinnant.
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// AAAAMMDD-HHMMSS (UTC), usado no nome dos arquivos da lixeira.
fn stamp(secs: u64) -> String {
    let (y, m, d) = civil((secs / 86_400) as i64);
    let r = secs % 86_400;
    format!("{y:04}{m:02}{d:02}-{:02}{:02}{:02}", r / 3600, r % 3600 / 60, r % 60)
}

/// Caminho relativo seguro: no máximo "pasta/arquivo.md", só [a-z0-9-].
fn valid_rel(p: &str) -> bool {
    let md = |f: &str| f.strip_suffix(".md").map_or(false, valid_slug);
    let parts: Vec<&str> = p.split('/').collect();
    match parts.as_slice() {
        [f] => md(f),
        [d, f] => valid_slug(d) && md(f),
        _ => false,
    }
}

fn norm_name(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn name_key(s: &str) -> String {
    norm_name(s).to_lowercase()
}

fn clip(s: &str) -> String {
    s.chars().take(MAX_NAME).collect::<String>().trim_end().to_string()
}

fn check_name(raw: &str, what: &str) -> Result<String, String> {
    let n = norm_name(raw);
    if n.is_empty() {
        Err(format!("Informe um nome para {what}."))
    } else if n.chars().count() > MAX_NAME {
        Err(format!("O nome pode ter no máximo {MAX_NAME} caracteres."))
    } else {
        Ok(n)
    }
}

/// Acrescenta `suffix` ao nome sem passar do limite de caracteres.
fn fit(base: &str, suffix: &str) -> String {
    let sc = suffix.chars().count();
    if sc >= MAX_NAME {
        return suffix.trim().chars().take(MAX_NAME).collect();
    }
    let keep: String = base.chars().take(MAX_NAME - sc).collect();
    format!("{}{}", keep.trim_end(), suffix)
}

fn deaccent(c: char) -> char {
    match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => 'a',
        'ç' | 'ć' | 'č' => 'c',
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ę' | 'ě' => 'e',
        'ì' | 'í' | 'î' | 'ï' | 'ī' => 'i',
        'ñ' | 'ń' | 'ň' => 'n',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' => 'o',
        'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ů' => 'u',
        'ý' | 'ÿ' => 'y',
        'ß' => 's',
        _ => c,
    }
}

fn is_reserved(s: &str) -> bool {
    matches!(s, "con" | "prn" | "aux" | "nul")
        || ((s.starts_with("com") || s.starts_with("lpt"))
            && s.len() == 4
            && s.as_bytes()[3].is_ascii_digit()
            && s.as_bytes()[3] != b'0')
}

/// minúsculas, sem acentos, hífens, no máximo 60 caracteres; nomes reservados
/// do Windows (con, nul, com1...) ganham o sufixo "-nota".
fn slugify(name: &str, fallback: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in name.chars().flat_map(|c| c.to_lowercase()) {
        let c = deaccent(c);
        if c.is_ascii_alphanumeric() {
            if dash && !out.is_empty() {
                out.push('-');
            }
            dash = false;
            out.push(c);
        } else {
            dash = true;
        }
    }
    out.truncate(MAX_SLUG);
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        out = fallback.to_string();
    }
    if is_reserved(&out) {
        out.push_str("-nota");
    }
    out
}

/// Grava num arquivo temporário e renomeia, para não corromper a nota
/// se o app fechar no meio da gravação.
fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, content).map_err(err)?;
    fs::rename(&tmp, path).map_err(err)
}

fn parse_list<T: serde::de::DeserializeOwned>(v: &Value, key: &str) -> Vec<T> {
    v.get(key)
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| serde_json::from_value(x.clone()).ok()).collect())
        .unwrap_or_default()
}

fn parse_index(v: &Value) -> Index {
    let ui = v.get("ui").and_then(|u| serde_json::from_value(u.clone()).ok()).unwrap_or_default();
    let mut index = Index {
        version: VERSION,
        projects: parse_list(v, "projects"),
        tabs: parse_list(v, "tabs"),
        trash: parse_list(v, "trash"),
        environments: parse_list(v, "environments"),
        ui,
    };
    sanitize(&mut index);
    // Um workspace.json nunca é fonte de valor de segredo: o que vier lá é descartado.
    for v in index.environments.iter_mut().flat_map(|e| e.variables.iter_mut()).filter(|v| v.secret) {
        v.value.clear();
        v.locked = false;
    }
    index
}

/// Descarta entradas inválidas do JSON (ids, cores, caminhos, duplicatas).
fn sanitize(ix: &mut Index) {
    let mut ids = HashSet::new();
    let mut folders = HashSet::new();
    ix.projects.retain_mut(|p| {
        p.name = clip(&norm_name(&p.name));
        valid_id(&p.id)
            && !p.name.is_empty()
            && PALETTE.contains(&p.color.as_str())
            && valid_slug(&p.folder)
            && ids.insert(p.id.clone())
            && folders.insert(p.folder.clone())
    });
    let pids: HashSet<String> = ix.projects.iter().map(|p| p.id.clone()).collect();
    let mut tids = HashSet::new();
    let mut files = HashSet::new();
    ix.tabs.retain_mut(|t| {
        t.name = clip(&norm_name(&t.name));
        if t.project_id.as_ref().map_or(false, |p| !pids.contains(p)) {
            t.project_id = None;
        }
        valid_id(&t.id)
            && !t.name.is_empty()
            && valid_rel(&t.file)
            && tids.insert(t.id.clone())
            && files.insert(t.file.clone())
    });
    let mut trash_ids = HashSet::new();
    let mut trash_files = HashSet::new();
    ix.trash.retain_mut(|t| {
        t.name = clip(&norm_name(&t.name));
        t.project_name = t.project_name.as_deref().map(|n| clip(&norm_name(n)));
        if t.project_color.as_deref().map_or(false, |c| !PALETTE.contains(&c)) {
            t.project_color = None;
        }
        valid_id(&t.id)
            && !t.name.is_empty()
            && valid_trash_file(&t.file)
            && trash_ids.insert(t.id.clone())
            && trash_files.insert(t.file.clone())
    });
    sanitize_envs(&mut ix.environments);
    let ui = std::mem::take(&mut ix.ui);
    ix.ui = clean_ui(ui, ix);
}

/// Chave de variável: letras, números, _ . - (sem espaços), até 64 caracteres.
fn valid_var_key(k: &str) -> bool {
    !k.is_empty() && k.len() <= 64 && k.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

/// Ids e nomes únicos (sem diferenciar maiúsculas), chaves únicas por ambiente; o que sobra
/// de inválido ou repetido é descartado.
fn sanitize_envs(envs: &mut Vec<Environment>) {
    let (mut ids, mut names) = (HashSet::new(), HashSet::new());
    envs.retain_mut(|e| {
        e.name = clip(&norm_name(&e.name));
        let mut keys = HashSet::new();
        e.variables.retain_mut(|v| {
            v.value = v.value.chars().take(2000).collect();
            v.description = v.description.chars().take(300).collect();
            valid_var_key(&v.key) && keys.insert(v.key.to_lowercase())
        });
        valid_id(&e.id) && !e.name.is_empty() && ids.insert(e.id.clone()) && names.insert(name_key(&e.name))
    });
}

fn clean_ui(mut ui: Ui, ix: &Index) -> Ui {
    let has_tab = |id: &str| ix.tabs.iter().any(|t| t.id == id);
    let filter_ok = |f: &str| f == "all" || f == "none" || ix.projects.iter().any(|p| p.id == f);
    if ui.active.as_deref().map_or(false, |a| !has_tab(a)) {
        ui.active = None;
    }
    if ui.view_mode.as_deref().map_or(false, |m| !VIEW_MODES.contains(&m)) {
        ui.view_mode = None;
    }
    if !filter_ok(&ui.filter) {
        ui.filter = default_filter();
    }
    ui.last_active.retain(|k, v| filter_ok(k) && has_tab(v));
    if ui.env.as_deref().map_or(false, |e| !ix.environments.iter().any(|x| x.id == e)) {
        ui.env = None;
    }
    ui
}

/// Cofre de segredos. O de verdade é o do sistema operacional; os testes usam um em memória.
trait SecretStore: Send {
    fn get(&self, id: &str) -> Result<Option<String>, String>;
    fn set(&self, id: &str, value: &str) -> Result<(), String>;
    fn delete(&self, id: &str) -> Result<(), String>;
}

/// Credential Manager (Windows), Keychain (macOS) ou Secret Service (Linux).
struct KeyringStore;

impl KeyringStore {
    fn entry(id: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SECRET_SERVICE, id).map_err(err)
    }
}

impl SecretStore for KeyringStore {
    fn get(&self, id: &str) -> Result<Option<String>, String> {
        match Self::entry(id)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(err(e)),
        }
    }

    fn set(&self, id: &str, value: &str) -> Result<(), String> {
        Self::entry(id)?.set_password(value).map_err(err)
    }

    fn delete(&self, id: &str) -> Result<(), String> {
        match Self::entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(err(e)),
        }
    }
}

/// Uma entrada por variável secreta, ligada ao ambiente e à chave (sem diferenciar maiúsculas).
fn secret_id(env_id: &str, key: &str) -> String {
    format!("env/{env_id}/{}", key.to_lowercase())
}

fn secret_ids(envs: &[Environment]) -> HashSet<String> {
    envs.iter()
        .flat_map(|e| e.variables.iter().filter(|v| v.secret).map(move |v| secret_id(&e.id, &v.key)))
        .collect()
}

struct Store {
    dir: PathBuf,
    index: Index,
    secrets: Box<dyn SecretStore>,
}

impl Store {
    fn open(dir: PathBuf) -> Result<Store, String> {
        Store::open_with(dir, Box::new(KeyringStore))
    }

    fn open_with(dir: PathBuf, secrets: Box<dyn SecretStore>) -> Result<Store, String> {
        fs::create_dir_all(&dir).map_err(err)?;
        let path = dir.join("workspace.json");
        if !path.exists() {
            return Ok(Store { dir, index: Index::empty(), secrets });
        }
        let raw = fs::read_to_string(&path).map_err(err)?;
        // Um JSON ilegível vira erro: nunca sobrescrevemos o que não entendemos.
        let v: Value = serde_json::from_str(&raw).map_err(|e| format!("workspace.json inválido: {e}"))?;
        if v.get("version").and_then(Value::as_u64).unwrap_or(1) < 2 {
            return Store::migrate_v1(dir, &v, secrets);
        }
        Ok(Store { index: parse_index(&v), dir, secrets })
    }

    /// v1: tabs/<id>.md na pasta do app. v2: <slug>.md na raiz, sem projeto.
    /// Copia tudo, grava o workspace.json novo e só então apaga os arquivos antigos.
    fn migrate_v1(dir: PathBuf, v: &Value, secrets: Box<dyn SecretStore>) -> Result<Store, String> {
        let mut tabs = Vec::new();
        let mut copies = Vec::new();
        let (mut ids, mut names, mut files) = (HashSet::new(), HashSet::new(), HashSet::new());
        let list = v.get("tabs").and_then(Value::as_array).cloned().unwrap_or_default();
        for t in &list {
            let Some(id) = t.get("id").and_then(Value::as_str) else { continue };
            if !valid_id(id) || !ids.insert(id.to_string()) {
                continue;
            }
            let mut name = clip(&norm_name(t.get("name").and_then(Value::as_str).unwrap_or("")));
            if name.is_empty() {
                name = "Sem nome".into();
            }
            let base = name.clone();
            let mut n = 2;
            while !names.insert(name_key(&name)) {
                name = fit(&base, &format!(" {n}"));
                n += 1;
            }
            let stem = slugify(&name, "nota");
            let mut file = format!("{stem}.md");
            let mut k = 2;
            while !files.insert(file.clone()) {
                file = format!("{stem}-{k}.md");
                k += 1;
            }
            copies.push((id.to_string(), file.clone()));
            tabs.push(TabMeta { id: id.to_string(), name, project_id: None, file });
        }
        for (id, file) in &copies {
            let old = dir.join("tabs").join(format!("{id}.md"));
            let new = dir.join(file);
            if old.exists() {
                fs::copy(&old, &new).map_err(err)?;
            } else {
                fs::write(&new, "").map_err(err)?;
            }
        }
        let ui = Ui {
            active: v.get("active").and_then(Value::as_str).map(String::from),
            view_mode: v.get("viewMode").and_then(Value::as_str).map(String::from),
            ..Ui::default()
        };
        let mut index = Index { version: VERSION, projects: vec![], tabs, trash: vec![], environments: vec![], ui };
        let ui = std::mem::take(&mut index.ui);
        index.ui = clean_ui(ui, &index);
        let store = Store { dir, index, secrets };
        store.persist()?;
        for (id, _) in &copies {
            let _ = fs::remove_file(store.dir.join("tabs").join(format!("{id}.md")));
        }
        let _ = fs::remove_dir(store.dir.join("tabs"));
        Ok(store)
    }

    fn persist(&self) -> Result<(), String> {
        let json = serde_json::to_string_pretty(&self.index).map_err(err)?;
        write_atomic(&self.dir.join("workspace.json"), &json)
    }

    fn load(&self) -> Option<Workspace> {
        if !self.dir.join("workspace.json").exists() {
            return None;
        }
        let tabs = self
            .index
            .tabs
            .iter()
            .map(|t| TabOut {
                meta: t.clone(),
                content: fs::read_to_string(self.dir.join(&t.file)).unwrap_or_default(),
            })
            .collect();
        Some(Workspace {
            projects: self.index.projects.clone(),
            tabs,
            environments: self.environments_with_secrets(),
            ui: self.index.ui.clone(),
            dir: self.dir.to_string_lossy().into_owned(),
        })
    }

    /// Ambientes como o front precisa: valores de segredo lidos do cofre. Se o cofre falhar,
    /// a variável vem sem valor e `locked`, para o front não sobrescrever o que está lá.
    fn environments_with_secrets(&self) -> Vec<Environment> {
        let mut envs = self.index.environments.clone();
        for e in &mut envs {
            let env_id = e.id.clone();
            for v in e.variables.iter_mut().filter(|v| v.secret) {
                match self.secrets.get(&secret_id(&env_id, &v.key)) {
                    Ok(val) => v.value = val.unwrap_or_default(),
                    Err(_) => v.locked = true,
                }
            }
        }
        envs
    }

    fn project_idx(&self, id: &str) -> Option<usize> {
        self.index.projects.iter().position(|p| p.id == id)
    }

    fn tab_idx(&self, id: &str) -> Result<usize, String> {
        self.index.tabs.iter().position(|t| t.id == id).ok_or_else(|| "aba não encontrada".to_string())
    }

    /// Pasta do projeto (None = raiz, "Sem projeto").
    fn folder_of(&self, project_id: Option<&str>) -> Result<Option<String>, String> {
        match project_id {
            None => Ok(None),
            Some(id) => self
                .project_idx(id)
                .map(|i| Some(self.index.projects[i].folder.clone()))
                .ok_or_else(|| "projeto não encontrado".to_string()),
        }
    }

    fn name_taken(&self, name: &str, project_id: Option<&str>, own: Option<&str>) -> bool {
        let key = name_key(name);
        self.index
            .tabs
            .iter()
            .any(|t| t.project_id.as_deref() == project_id && Some(t.id.as_str()) != own && name_key(&t.name) == key)
    }

    /// slug.md, slug-2.md, slug-3.md... livre no índice e no disco.
    fn unique_file(&self, folder: Option<&str>, base: &str, own: Option<&str>) -> String {
        let own_file = own.and_then(|id| self.index.tabs.iter().find(|t| t.id == id)).map(|t| t.file.clone());
        let mut n = 1;
        loop {
            let stem = if n == 1 { base.to_string() } else { format!("{base}-{n}") };
            let cand = match folder {
                Some(f) => format!("{f}/{stem}.md"),
                None => format!("{stem}.md"),
            };
            let used = self.index.tabs.iter().any(|t| t.file == cand && Some(t.id.as_str()) != own)
                || (self.dir.join(&cand).exists() && Some(&cand) != own_file.as_ref());
            if !used {
                return cand;
            }
            n += 1;
        }
    }

    fn unique_folder(&self, base: &str, own: Option<&str>) -> String {
        let own_folder = own.and_then(|id| self.project_idx(id)).map(|i| self.index.projects[i].folder.clone());
        let mut n = 1;
        loop {
            let cand = if n == 1 { base.to_string() } else { format!("{base}-{n}") };
            let used = self.index.projects.iter().any(|p| p.folder == cand && Some(p.id.as_str()) != own)
                || (self.dir.join(&cand).exists() && Some(&cand) != own_folder.as_ref());
            if !used {
                return cand;
            }
            n += 1;
        }
    }

    fn move_file(&self, old: &str, new: &str) -> Result<(), String> {
        if old == new {
            return Ok(());
        }
        let (o, n) = (self.dir.join(old), self.dir.join(new));
        if let Some(p) = n.parent() {
            fs::create_dir_all(p).map_err(err)?;
        }
        if o.exists() {
            fs::rename(&o, &n).map_err(err)
        } else {
            write_atomic(&n, "")
        }
    }

    fn create_tab(&mut self, id: &str, name: &str, project_id: Option<&str>) -> Result<String, String> {
        if !valid_id(id) || self.index.tabs.iter().any(|t| t.id == id) {
            return Err("id de aba inválido".into());
        }
        let name = check_name(name, "a aba")?;
        let folder = self.folder_of(project_id)?;
        if self.name_taken(&name, project_id, None) {
            return Err(DUP_TAB.into());
        }
        let file = self.unique_file(folder.as_deref(), &slugify(&name, "nota"), None);
        write_atomic(&self.dir.join(&file), "")?;
        self.index.tabs.push(TabMeta {
            id: id.to_string(),
            name,
            project_id: project_id.map(String::from),
            file: file.clone(),
        });
        self.persist()?;
        Ok(file)
    }

    /// Renomeia e/ou move a aba; o arquivo acompanha.
    fn update_tab(&mut self, id: &str, name: &str, project_id: Option<&str>) -> Result<String, String> {
        let ti = self.tab_idx(id)?;
        let name = check_name(name, "a aba")?;
        let folder = self.folder_of(project_id)?;
        if self.name_taken(&name, project_id, Some(id)) {
            return Err(DUP_TAB.into());
        }
        let old = self.index.tabs[ti].clone();
        let file = if old.project_id.as_deref() == project_id && old.name == name {
            old.file.clone()
        } else {
            self.unique_file(folder.as_deref(), &slugify(&name, "nota"), Some(id))
        };
        self.move_file(&old.file, &file)?;
        let t = &mut self.index.tabs[ti];
        t.name = name;
        t.project_id = project_id.map(String::from);
        t.file = file.clone();
        self.persist()?;
        Ok(file)
    }

    fn save_tab(&self, id: &str, content: &str) -> Result<(), String> {
        let t = &self.index.tabs[self.tab_idx(id)?];
        write_atomic(&self.dir.join(&t.file), content)
    }

    /// Fechar aba: o arquivo vai para .lixeira/ (com data). Aba em branco é apagada de vez.
    /// Devolve true se foi para a lixeira.
    fn trash_tab(&mut self, id: &str, now: u64) -> Result<bool, String> {
        let ti = self.tab_idx(id)?;
        let tab = self.index.tabs[ti].clone();
        let src = self.dir.join(&tab.file);
        let blank = match fs::read(&src) {
            Ok(bytes) => bytes.iter().all(u8::is_ascii_whitespace),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
            Err(e) => return Err(err(e)),
        };
        if blank {
            match fs::remove_file(&src) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(err(e)),
            }
            self.index.tabs.remove(ti);
            self.persist()?;
            return Ok(false);
        }
        let trash_dir = self.dir.join(TRASH_DIR);
        fs::create_dir_all(&trash_dir).map_err(err)?;
        let stem = format!("{}-{}", stamp(now), slugify(&tab.name, "nota"));
        let mut file = format!("{stem}.md");
        let mut n = 2;
        while trash_dir.join(&file).exists() || self.index.trash.iter().any(|t| t.file == file) {
            file = format!("{stem}-{n}.md");
            n += 1;
        }
        fs::rename(&src, trash_dir.join(&file)).map_err(err)?;
        let project = tab.project_id.as_deref().and_then(|p| self.project_idx(p)).map(|i| self.index.projects[i].clone());
        self.index.trash.push(TrashItem {
            id: tab.id.clone(),
            name: tab.name.clone(),
            project_id: project.as_ref().map(|p| p.id.clone()),
            project_name: project.as_ref().map(|p| p.name.clone()),
            project_color: project.as_ref().map(|p| p.color.clone()),
            deleted_at: now,
            file,
        });
        self.index.tabs.remove(ti);
        self.persist()?;
        Ok(true)
    }

    fn list_trash(&self) -> Vec<TrashItem> {
        let mut items = self.index.trash.clone();
        items.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
        items
    }

    /// Devolve a aba ao projeto de origem (ou a "Sem projeto" se ele não existe mais).
    /// Se o nome já estiver em uso lá, acrescenta " (restaurada)".
    fn restore_trash(&mut self, id: &str) -> Result<TabOut, String> {
        let xi = self.index.trash.iter().position(|t| t.id == id).ok_or("item não encontrado na lixeira")?;
        let item = self.index.trash[xi].clone();
        let src = self.dir.join(TRASH_DIR).join(&item.file);
        if !src.exists() {
            self.index.trash.remove(xi);
            self.persist()?;
            return Err("o arquivo desta aba não está mais na lixeira".into());
        }
        if self.index.tabs.iter().any(|t| t.id == id) {
            return Err("id de aba já em uso".into());
        }
        let pid = item.project_id.clone().filter(|p| self.project_idx(p).is_some());
        let folder = self.folder_of(pid.as_deref())?;
        let mut name = item.name.clone();
        if self.name_taken(&name, pid.as_deref(), None) {
            let first = fit(&item.name, " (restaurada)");
            name = first.clone();
            let mut n = 2;
            while self.name_taken(&name, pid.as_deref(), None) {
                name = fit(&first, &format!(" {n}"));
                n += 1;
            }
        }
        let file = self.unique_file(folder.as_deref(), &slugify(&name, "nota"), None);
        let dst = self.dir.join(&file);
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(err)?;
        }
        fs::rename(&src, &dst).map_err(err)?;
        let meta = TabMeta { id: id.to_string(), name, project_id: pid, file };
        self.index.tabs.push(meta.clone());
        self.index.trash.remove(xi);
        self.persist()?;
        Ok(TabOut { meta, content: fs::read_to_string(&dst).unwrap_or_default() })
    }

    /// Apaga de vez tudo o que está na lixeira. Devolve quantos itens eram.
    fn empty_trash(&mut self) -> Result<usize, String> {
        let n = self.index.trash.len();
        for t in &self.index.trash {
            match fs::remove_file(self.dir.join(TRASH_DIR).join(&t.file)) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(err(e)),
            }
        }
        self.index.trash.clear();
        let _ = fs::remove_dir(self.dir.join(TRASH_DIR)); // só remove se estiver vazia
        self.persist()?;
        Ok(n)
    }

    /// Cria uma aba nova com o conteúdo de um arquivo importado. O nome vem do arquivo e
    /// ganha " 2", " 3"... se já existir no projeto.
    fn import_tab(&mut self, id: &str, stem: &str, content: &str, project_id: Option<&str>) -> Result<TabOut, String> {
        let mut name = clip(&norm_name(stem));
        if name.is_empty() {
            name = "Sem nome".into();
        }
        let base = name.clone();
        let mut n = 2;
        while self.name_taken(&name, project_id, None) {
            name = fit(&base, &format!(" {n}"));
            n += 1;
        }
        self.create_tab(id, &name, project_id)?;
        self.save_tab(id, content)?;
        let meta = self.index.tabs[self.tab_idx(id)?].clone();
        Ok(TabOut { meta, content: content.to_string() })
    }

    /// Grava o conteúdo da aba em `dest` (acrescenta .md se faltar extensão).
    fn export_tab(&self, id: &str, dest: &Path) -> Result<PathBuf, String> {
        let t = &self.index.tabs[self.tab_idx(id)?];
        let content = fs::read_to_string(self.dir.join(&t.file)).unwrap_or_default();
        let mut dest = dest.to_path_buf();
        if dest.extension().is_none() {
            dest.set_extension("md");
        }
        write_atomic(&dest, &content)?;
        Ok(dest)
    }

    /// Substitui a lista de ambientes (o front manda tudo de uma vez). Inválidos e repetidos
    /// são descartados; se o ambiente ativo sumiu, a seleção é limpa.
    ///
    /// Segredos vão para o cofre do sistema e saem do índice: o valor nunca chega ao disco.
    /// Se o cofre falhar, a gravação inteira falha (não existe plano B em texto puro).
    fn save_environments(&mut self, mut envs: Vec<Environment>) -> Result<(), String> {
        sanitize_envs(&mut envs);
        for v in envs.iter().flat_map(|e| e.variables.iter()).filter(|v| v.secret) {
            if v.value.chars().count() > MAX_SECRET_CHARS {
                return Err(format!("O valor de um segredo pode ter até {MAX_SECRET_CHARS} caracteres (“{}” passou).", v.key));
            }
        }
        for e in &envs {
            for v in e.variables.iter().filter(|v| v.secret && !v.locked) {
                let id = secret_id(&e.id, &v.key);
                let cofre = |m: String| format!("Não foi possível usar o cofre do sistema para “{}”: {m}", v.key);
                if v.value.is_empty() {
                    self.secrets.delete(&id).map_err(cofre)?;
                } else if self.secrets.get(&id).map_err(cofre)?.as_deref() != Some(v.value.as_str()) {
                    self.secrets.set(&id, &v.value).map_err(cofre)?;
                }
            }
        }
        // O que deixou de ser segredo (ou foi renomeado/excluído) sai do cofre.
        let keep = secret_ids(&envs);
        for id in secret_ids(&self.index.environments).difference(&keep) {
            if let Err(e) = self.secrets.delete(id) {
                eprintln!("cofre: não removi {id}: {e}");
            }
        }
        for v in envs.iter_mut().flat_map(|e| e.variables.iter_mut()).filter(|v| v.secret) {
            v.value.clear();
            v.locked = false;
        }
        self.index.environments = envs;
        let ui = std::mem::take(&mut self.index.ui);
        self.index.ui = clean_ui(ui, &self.index);
        self.persist()
    }

    fn save_ui(&mut self, ui: Ui) -> Result<(), String> {
        self.index.ui = clean_ui(ui, &self.index);
        self.persist()
    }

    fn create_project(&mut self, id: &str, name: &str, color: &str) -> Result<String, String> {
        if !valid_id(id) || self.project_idx(id).is_some() {
            return Err("id de projeto inválido".into());
        }
        let name = check_name(name, "o projeto")?;
        if !PALETTE.contains(&color) {
            return Err("cor fora da paleta".into());
        }
        if self.index.projects.iter().any(|p| name_key(&p.name) == name_key(&name)) {
            return Err(DUP_PROJECT.into());
        }
        let folder = self.unique_folder(&slugify(&name, "projeto"), None);
        fs::create_dir_all(self.dir.join(&folder)).map_err(err)?;
        self.index.projects.push(Project { id: id.to_string(), name, color: color.to_string(), folder: folder.clone() });
        self.persist()?;
        Ok(folder)
    }

    /// Renomear o projeto renomeia a pasta. Devolve idAba -> caminho de cada aba dele.
    fn update_project(&mut self, id: &str, name: &str, color: &str) -> Result<HashMap<String, String>, String> {
        let pi = self.project_idx(id).ok_or("projeto não encontrado")?;
        let name = check_name(name, "o projeto")?;
        if !PALETTE.contains(&color) {
            return Err("cor fora da paleta".into());
        }
        if self.index.projects.iter().any(|p| p.id != id && name_key(&p.name) == name_key(&name)) {
            return Err(DUP_PROJECT.into());
        }
        let old = self.index.projects[pi].clone();
        let mut folder = old.folder.clone();
        if name != old.name {
            let cand = self.unique_folder(&slugify(&name, "projeto"), Some(id));
            if cand != old.folder {
                let o = self.dir.join(&old.folder);
                if o.exists() {
                    fs::rename(&o, self.dir.join(&cand)).map_err(err)?;
                }
                folder = cand;
            }
        }
        let mut files = HashMap::new();
        for t in self.index.tabs.iter_mut().filter(|t| t.project_id.as_deref() == Some(id)) {
            let stem = t.file.rsplit('/').next().unwrap_or(&t.file).to_string();
            t.file = format!("{folder}/{stem}");
            files.insert(t.id.clone(), t.file.clone());
        }
        let p = &mut self.index.projects[pi];
        p.name = name;
        p.color = color.to_string();
        p.folder = folder;
        self.persist()?;
        Ok(files)
    }

    /// Nunca apaga anotações: as abas vão para "Sem projeto". Se o nome colidir
    /// lá, acrescenta " (Nome do projeto)" ao nome da aba.
    fn delete_project(&mut self, id: &str) -> Result<DeleteResult, String> {
        let pi = self.project_idx(id).ok_or("projeto não encontrado")?;
        let project = self.index.projects[pi].clone();
        let ids: Vec<String> = self
            .index
            .tabs
            .iter()
            .filter(|t| t.project_id.as_deref() == Some(id))
            .map(|t| t.id.clone())
            .collect();
        let (mut files, mut names) = (HashMap::new(), HashMap::new());
        for tid in ids {
            let ti = self.tab_idx(&tid)?;
            let tab = self.index.tabs[ti].clone();
            let mut name = tab.name.clone();
            if self.name_taken(&name, None, Some(&tid)) {
                let first = fit(&tab.name, &format!(" ({})", project.name));
                name = first.clone();
                let mut n = 2;
                while self.name_taken(&name, None, Some(&tid)) {
                    name = fit(&first, &format!(" {n}"));
                    n += 1;
                }
            }
            let file = self.unique_file(None, &slugify(&name, "nota"), Some(&tid));
            if let Err(e) = self.move_file(&tab.file, &file) {
                let _ = self.persist(); // guarda o que já foi movido
                return Err(e);
            }
            let t = &mut self.index.tabs[ti];
            t.project_id = None;
            t.file = file.clone();
            if name != tab.name {
                names.insert(tid.clone(), name.clone());
                t.name = name;
            }
            files.insert(tid, file);
        }
        let _ = fs::remove_dir(self.dir.join(&project.folder)); // só remove se estiver vazia
        self.index.projects.remove(pi);
        if self.index.ui.filter == id {
            self.index.ui.filter = default_filter();
        }
        self.index.ui.last_active.remove(id);
        self.persist()?;
        Ok(DeleteResult { files, names, filter: self.index.ui.filter.clone() })
    }
}

/// Copia as notas para `new` e só então apaga as antigas. O workspace.json vai por
/// último: uma cópia interrompida não vira um workspace válido na pasta nova.
fn relocate(store: &Store, new: &Path) -> Result<(), String> {
    let old = &store.dir;
    fs::create_dir_all(new).map_err(err)?;
    let (o, n) = (fs::canonicalize(old).map_err(err)?, fs::canonicalize(new).map_err(err)?);
    if o == n {
        return Ok(());
    }
    if n.starts_with(&o) || o.starts_with(&n) {
        return Err("A nova pasta não pode ficar dentro da pasta atual das notas, nem o contrário.".into());
    }
    if n.join("workspace.json").exists() {
        return Err("A pasta escolhida já tem notas (workspace.json). Escolha outra pasta ou desmarque “mover as notas existentes” para abrir as notas dela.".into());
    }
    let mut rels: Vec<String> = store.index.tabs.iter().map(|t| t.file.clone()).collect();
    rels.extend(store.index.trash.iter().map(|t| format!("{TRASH_DIR}/{}", t.file)));
    rels.push("workspace.json".into());
    let mut copied: Vec<PathBuf> = Vec::new();
    let copy_all = |copied: &mut Vec<PathBuf>| -> Result<(), String> {
        for rel in &rels {
            let src = old.join(rel);
            if !src.exists() {
                continue;
            }
            let dst = new.join(rel);
            if let Some(p) = dst.parent() {
                fs::create_dir_all(p).map_err(err)?;
            }
            fs::copy(&src, &dst).map_err(err)?;
            copied.push(dst);
        }
        Ok(())
    };
    if let Err(e) = copy_all(&mut copied) {
        for p in copied {
            let _ = fs::remove_file(p);
        }
        return Err(format!("Não foi possível copiar as notas: {e}"));
    }
    for rel in &rels {
        let _ = fs::remove_file(old.join(rel));
    }
    for p in &store.index.projects {
        let _ = fs::remove_dir(old.join(&p.folder));
    }
    let _ = fs::remove_dir(old.join(TRASH_DIR));
    Ok(())
}

/// Configuração fora da pasta das notas (ela pode estar no OneDrive/Git).
#[derive(Serialize, Deserialize, Clone, Default)]
struct Config {
    #[serde(rename = "notesDir", default)]
    notes_dir: Option<String>,
    #[serde(default)]
    shortcut: Option<String>,
}

struct Inner {
    config: Config,
    config_path: PathBuf,
    default_dir: PathBuf,
    store: Option<Store>,
    shortcut_error: Option<String>,
}

impl Inner {
    fn notes_dir(&self) -> PathBuf {
        self.config.notes_dir.as_ref().map(PathBuf::from).unwrap_or_else(|| self.default_dir.clone())
    }

    fn shortcut(&self) -> String {
        self.config.shortcut.clone().unwrap_or_else(|| DEFAULT_SHORTCUT.to_string())
    }

    fn save_config(&self) -> Result<(), String> {
        let json = serde_json::to_string_pretty(&self.config).map_err(err)?;
        write_atomic(&self.config_path, &json)
    }
}

struct AppState(Mutex<Inner>);

fn with_store<T>(state: &State<AppState>, f: impl FnOnce(&mut Store) -> Result<T, String>) -> Result<T, String> {
    let mut g = state.0.lock().map_err(|_| "estado interno corrompido".to_string())?;
    if g.store.is_none() {
        let dir = g.notes_dir();
        g.store = Some(Store::open(dir)?);
    }
    f(g.store.as_mut().expect("store aberto acima"))
}

#[tauri::command]
fn load_workspace(state: State<AppState>) -> Result<Option<Workspace>, String> {
    with_store(&state, |s| Ok(s.load()))
}

#[tauri::command]
fn save_tab(state: State<AppState>, id: String, content: String) -> Result<(), String> {
    with_store(&state, |s| s.save_tab(&id, &content))
}

#[tauri::command]
fn save_environments(state: State<AppState>, environments: Vec<Environment>) -> Result<(), String> {
    with_store(&state, |s| s.save_environments(environments))
}

#[tauri::command]
fn save_ui(state: State<AppState>, ui: Ui) -> Result<(), String> {
    with_store(&state, |s| s.save_ui(ui))
}

/// Devolve o caminho relativo do arquivo criado.
#[tauri::command]
fn create_tab(state: State<AppState>, id: String, name: String, project_id: Option<String>) -> Result<String, String> {
    with_store(&state, |s| s.create_tab(&id, &name, project_id.as_deref()))
}

/// Renomeia e/ou move a aba; devolve o novo caminho.
#[tauri::command]
fn update_tab(state: State<AppState>, id: String, name: String, project_id: Option<String>) -> Result<String, String> {
    with_store(&state, |s| s.update_tab(&id, &name, project_id.as_deref()))
}

/// Fecha a aba: vai para a lixeira (true) ou é apagada de vez se estava em branco (false).
#[tauri::command]
fn trash_tab(state: State<AppState>, id: String) -> Result<bool, String> {
    with_store(&state, |s| s.trash_tab(&id, now_secs()))
}

#[tauri::command]
fn list_trash(state: State<AppState>) -> Result<Vec<TrashItem>, String> {
    with_store(&state, |s| Ok(s.list_trash()))
}

#[tauri::command]
fn restore_trash(state: State<AppState>, id: String) -> Result<TabOut, String> {
    with_store(&state, |s| s.restore_trash(&id))
}

#[tauri::command]
fn empty_trash(state: State<AppState>) -> Result<usize, String> {
    with_store(&state, |s| s.empty_trash())
}

/// Devolve a pasta do projeto.
#[tauri::command]
fn create_project(state: State<AppState>, id: String, name: String, color: String) -> Result<String, String> {
    with_store(&state, |s| s.create_project(&id, &name, &color))
}

#[tauri::command]
fn update_project(state: State<AppState>, id: String, name: String, color: String) -> Result<HashMap<String, String>, String> {
    with_store(&state, |s| s.update_project(&id, &name, &color))
}

#[tauri::command]
fn delete_project(state: State<AppState>, id: String) -> Result<DeleteResult, String> {
    with_store(&state, |s| s.delete_project(&id))
}

/// Importa um .md (ou .txt) como aba nova. `path` vem do diálogo de arquivos.
#[tauri::command]
fn import_tab(state: State<AppState>, id: String, path: String, project_id: Option<String>) -> Result<TabOut, String> {
    let p = PathBuf::from(&path);
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if !matches!(ext.as_str(), "md" | "markdown" | "txt") {
        return Err("Só dá para importar arquivos .md, .markdown ou .txt.".into());
    }
    let meta = fs::metadata(&p).map_err(err)?;
    if !meta.is_file() || meta.len() > MAX_IMPORT_BYTES {
        return Err("O arquivo não existe ou passa de 5 MB.".into());
    }
    let raw = fs::read_to_string(&p).map_err(|_| "O arquivo não é um texto UTF-8.".to_string())?;
    let content = raw.strip_prefix('\u{feff}').unwrap_or(&raw).to_string();
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
    with_store(&state, |s| s.import_tab(&id, &stem, &content, project_id.as_deref()))
}

/// Exporta a aba para `path` (do diálogo de salvar). Devolve o caminho gravado.
#[tauri::command]
fn export_tab(state: State<AppState>, id: String, path: String) -> Result<String, String> {
    with_store(&state, |s| s.export_tab(&id, Path::new(&path))).map(|p| p.to_string_lossy().into_owned())
}

#[derive(Serialize)]
struct SettingsOut {
    #[serde(rename = "notesDir")]
    notes_dir: String,
    #[serde(rename = "defaultDir")]
    default_dir: String,
    shortcut: String,
    #[serde(rename = "defaultShortcut")]
    default_shortcut: String,
    #[serde(rename = "shortcutError")]
    shortcut_error: Option<String>,
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> Result<SettingsOut, String> {
    let g = state.0.lock().map_err(|_| "estado interno corrompido".to_string())?;
    Ok(SettingsOut {
        notes_dir: g.notes_dir().to_string_lossy().into_owned(),
        default_dir: g.default_dir.to_string_lossy().into_owned(),
        shortcut: g.shortcut(),
        default_shortcut: DEFAULT_SHORTCUT.into(),
        shortcut_error: g.shortcut_error.clone(),
    })
}

/// Troca a pasta das notas, movendo as atuais para ela se pedido. O front recarrega depois.
#[tauri::command]
fn set_notes_dir(state: State<AppState>, path: String, move_existing: bool) -> Result<String, String> {
    let p = PathBuf::from(path.trim());
    if !p.is_absolute() {
        return Err("Informe o caminho completo da pasta.".into());
    }
    let mut g = state.0.lock().map_err(|_| "estado interno corrompido".to_string())?;
    if move_existing {
        if g.store.is_none() {
            let dir = g.notes_dir();
            g.store = Some(Store::open(dir)?);
        }
        let store = g.store.as_ref().expect("store aberto acima");
        if store.dir.join("workspace.json").exists() {
            store.persist()?;
        }
        relocate(store, &p)?;
    } else {
        fs::create_dir_all(&p).map_err(err)?;
    }
    g.store = None;
    g.config.notes_dir = if p == g.default_dir { None } else { Some(p.to_string_lossy().into_owned()) };
    g.save_config()?;
    Ok(p.to_string_lossy().into_owned())
}

/// Troca o atalho global. O novo é registrado antes de soltar o antigo.
#[tauri::command]
fn set_shortcut(app: tauri::AppHandle, state: State<AppState>, shortcut: String) -> Result<(), String> {
    let new = Shortcut::from_str(&shortcut).map_err(|e| format!("Atalho inválido: {e}"))?;
    let mut g = state.0.lock().map_err(|_| "estado interno corrompido".to_string())?;
    let old = g.shortcut();
    let old_parsed = Shortcut::from_str(&old).ok();
    if old_parsed != Some(new) || g.shortcut_error.is_some() {
        app.global_shortcut()
            .register(new)
            .map_err(|_| "Não foi possível registrar: outro programa já usa esse atalho.".to_string())?;
        if let Some(o) = old_parsed.filter(|o| *o != new && g.shortcut_error.is_none()) {
            let _ = app.global_shortcut().unregister(o);
        }
    }
    g.config.shortcut = if shortcut == DEFAULT_SHORTCUT { None } else { Some(shortcut) };
    g.shortcut_error = None;
    g.save_config()
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Mostra a janela por cima de tudo e pede ao front para focar o editor.
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        let _ = w.emit("focus-editor", ());
    }
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Mostrar CleanNotes", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("CleanNotes")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id.as_ref() {
            "show" => show_main(app),
            "quit" => {
                // O front grava o que estiver pendente e chama quit_app; o prazo evita ficar preso.
                let _ = app.emit("quit-requested", ());
                let handle = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    handle.exit(0);
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Iniciado com o sistema, o app abre escondido (bandeja + atalho global).
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--minimizado"])))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, ev| {
                    if ev.state() == ShortcutState::Pressed {
                        show_main(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let default_dir = app.path().app_data_dir()?.join("workspace");
            let config_path = app.path().app_config_dir()?.join("config.json");
            let config = fs::read_to_string(&config_path)
                .ok()
                .and_then(|raw| serde_json::from_str::<Config>(&raw).ok())
                .unwrap_or_default();
            let mut inner = Inner { config, config_path, default_dir, store: None, shortcut_error: None };
            match Shortcut::from_str(&inner.shortcut()) {
                Ok(sc) => {
                    if app.global_shortcut().register(sc).is_err() {
                        inner.shortcut_error = Some("Outro programa já usa esse atalho global.".into());
                    }
                }
                Err(e) => inner.shortcut_error = Some(format!("Atalho inválido: {e}")),
            }
            app.manage(AppState(Mutex::new(inner)));
            // A bandeja é um extra: sem ela (ex.: Linux sem appindicator) o app segue funcionando.
            if let Err(e) = build_tray(app) {
                eprintln!("bandeja indisponível: {e}");
            }
            if std::env::args().any(|a| a == "--minimizado") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_workspace,
            save_tab,
            save_ui,
            save_environments,
            create_tab,
            update_tab,
            trash_tab,
            list_trash,
            restore_trash,
            empty_trash,
            create_project,
            update_project,
            delete_project,
            import_tab,
            export_tab,
            get_settings,
            set_notes_dir,
            set_shortcut,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o CleanNotes");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("cleannotes-test-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn slugify_remove_acentos_e_trata_reservados() {
        assert_eq!(slugify("Anotações AWS", "nota"), "anotacoes-aws");
        assert_eq!(slugify("  Árvore -- de  Ação!! ", "nota"), "arvore-de-acao");
        assert_eq!(slugify("???", "nota"), "nota");
        assert_eq!(slugify("CON", "nota"), "con-nota");
        assert_eq!(slugify("com1", "nota"), "com1-nota");
        assert_eq!(slugify("Nul", "nota"), "nul-nota");
        assert_eq!(slugify("com10", "nota"), "com10");
        assert_eq!(slugify(&"a".repeat(100), "nota").len(), 60);
    }

    #[test]
    fn caminho_relativo_seguro() {
        assert!(valid_rel("nota.md"));
        assert!(valid_rel("loja-online/anotacoes-aws.md"));
        assert!(!valid_rel("../nota.md"));
        assert!(!valid_rel("a/b/c.md"));
        assert!(!valid_rel("/etc/passwd.md"));
        assert!(!valid_rel("Nota.md"));
        assert!(!valid_rel("nota.txt"));
        assert!(!valid_rel("a\\b.md"));
        assert!(!valid_rel(".md"));
        assert!(!valid_rel("pasta//nota.md"));
    }

    #[test]
    fn mesmo_nome_em_projetos_diferentes() {
        let dir = tmp("projetos");
        let mut s = Store::open(dir.clone()).unwrap();
        s.create_project("p1", "Loja Online", "azul").unwrap();
        s.create_project("p2", "Infra Interna", "verde").unwrap();
        assert!(s.create_project("p3", "  loja   ONLINE ", "rosa").is_err());
        assert!(s.create_project("p3", "Outro", "magenta").is_err());

        let a = s.create_tab("t1", "Anotações AWS", Some("p1")).unwrap();
        let b = s.create_tab("t2", "Anotações AWS", Some("p2")).unwrap();
        assert_eq!(a, "loja-online/anotacoes-aws.md");
        assert_eq!(b, "infra-interna/anotacoes-aws.md");
        assert!(s.create_tab("t3", "anotações  aws", Some("p1")).is_err());
        s.create_tab("t3", "Anotações AWS", None).unwrap();

        // mover para onde já existe o mesmo nome é recusado; renomear projeto move a pasta
        assert!(s.update_tab("t3", "Anotações AWS", Some("p1")).is_err());
        s.save_tab("t1", "conteúdo").unwrap();
        let files = s.update_project("p1", "Loja Nova", "roxo").unwrap();
        assert_eq!(files["t1"], "loja-nova/anotacoes-aws.md");
        assert_eq!(fs::read_to_string(dir.join("loja-nova/anotacoes-aws.md")).unwrap(), "conteúdo");
        assert!(!dir.join("loja-online").exists());

        // excluir o projeto não apaga nada; colisão em "Sem projeto" ganha o nome do projeto
        let res = s.delete_project("p1").unwrap();
        assert_eq!(res.names["t1"], "Anotações AWS (Loja Nova)");
        assert_eq!(res.files["t1"], "anotacoes-aws-loja-nova.md");
        assert_eq!(fs::read_to_string(dir.join("anotacoes-aws-loja-nova.md")).unwrap(), "conteúdo");
        assert!(!dir.join("loja-nova").exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn migracao_v1_para_v2() {
        let dir = tmp("migracao");
        fs::create_dir_all(dir.join("tabs")).unwrap();
        fs::write(dir.join("tabs/abc123.md"), "# Olá\nconteúdo").unwrap();
        fs::write(dir.join("tabs/def456.md"), "x").unwrap();
        fs::write(
            dir.join("workspace.json"),
            r#"{"version":1,"active":"def456","viewMode":"preview","tabs":[
                {"id":"abc123","name":"Servidores AWS"},{"id":"def456","name":"CON"}]}"#,
        )
        .unwrap();

        let s = Store::open(dir.clone()).unwrap();
        let ws = s.load().unwrap();
        assert!(ws.projects.is_empty());
        assert_eq!(ws.tabs.len(), 2);
        assert_eq!(ws.tabs[0].meta.file, "servidores-aws.md");
        assert_eq!(ws.tabs[0].content, "# Olá\nconteúdo");
        assert_eq!(ws.tabs[0].meta.project_id, None);
        assert_eq!(ws.tabs[1].meta.file, "con-nota.md");
        assert_eq!(ws.ui.active.as_deref(), Some("def456"));
        assert_eq!(ws.ui.view_mode.as_deref(), Some("preview"));
        assert!(!dir.join("tabs").exists());
        let json: Value = serde_json::from_str(&fs::read_to_string(dir.join("workspace.json")).unwrap()).unwrap();
        assert_eq!(json["version"], 2);

        // reabrir lê o v2 sem migrar de novo
        let again = Store::open(dir.clone()).unwrap().load().unwrap();
        assert_eq!(again.tabs[0].content, "# Olá\nconteúdo");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn lixeira_restaura_conteudo_identico() {
        let dir = tmp("lixeira");
        let mut s = Store::open(dir.clone()).unwrap();
        s.create_project("p1", "Loja", "azul").unwrap();
        s.create_tab("t1", "Anotações AWS", Some("p1")).unwrap();
        s.create_tab("t2", "Vazia", None).unwrap();
        let original = "# Olá\r\n\n```bash\nls -la\n```\nacentuação: ç ã é\n";
        s.save_tab("t1", original).unwrap();

        // aba em branco é apagada de vez; a com conteúdo vai para a lixeira, com data no nome
        assert!(!s.trash_tab("t2", 0).unwrap());
        assert!(s.list_trash().is_empty());
        assert!(s.trash_tab("t1", 1_700_000_000).unwrap());
        let item = &s.list_trash()[0];
        assert_eq!(item.file, "20231114-221320-anotacoes-aws.md");
        assert!(dir.join(".lixeira/20231114-221320-anotacoes-aws.md").exists());
        assert!(!dir.join("loja/anotacoes-aws.md").exists());
        assert!(s.index.tabs.is_empty());

        // outra aba com o mesmo nome ocupou o lugar: a restaurada ganha " (restaurada)"
        s.create_tab("t3", "Anotações AWS", Some("p1")).unwrap();
        let back = s.restore_trash("t1").unwrap();
        assert_eq!(back.content, original);
        assert_eq!(back.meta.name, "Anotações AWS (restaurada)");
        assert_eq!(back.meta.project_id.as_deref(), Some("p1"));
        assert_eq!(fs::read_to_string(dir.join(&back.meta.file)).unwrap(), original);
        assert!(s.list_trash().is_empty());

        // projeto que não existe mais: volta para "Sem projeto"; esvaziar apaga os arquivos
        s.trash_tab("t1", 1_700_000_100).unwrap();
        s.delete_project("p1").unwrap();
        let again = s.restore_trash("t1").unwrap();
        assert_eq!(again.meta.project_id, None);
        assert_eq!(again.content, original);
        s.trash_tab("t1", 1_700_000_200).unwrap();
        assert_eq!(s.empty_trash().unwrap(), 1);
        assert!(!dir.join(".lixeira").exists());

        // a lixeira sobrevive a fechar e abrir o app
        s.save_tab("t3", "ainda aqui").unwrap();
        assert!(s.trash_tab("t3", 1_700_000_300).unwrap());
        let reopened = Store::open(dir.clone()).unwrap();
        assert_eq!(reopened.list_trash().len(), 1);
        assert_eq!(reopened.list_trash()[0].name, "Anotações AWS");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn mudar_pasta_das_notas_move_tudo_e_recusa_pasta_aninhada() {
        let base = tmp("relocate");
        let (old, new) = (base.join("antiga"), base.join("nova"));
        let mut s = Store::open(old.clone()).unwrap();
        s.create_project("p1", "Loja", "azul").unwrap();
        s.create_tab("t1", "Nota A", Some("p1")).unwrap();
        s.create_tab("t2", "Nota B", None).unwrap();
        s.save_tab("t1", "conteúdo A").unwrap();
        s.save_tab("t2", "conteúdo B").unwrap();
        s.trash_tab("t2", 1_700_000_000).unwrap();

        assert!(relocate(&s, &old.join("dentro")).is_err());
        assert!(relocate(&s, &base).is_err());
        relocate(&s, &new).unwrap();
        assert!(!old.join("workspace.json").exists());
        assert!(!old.join("loja").exists() && !old.join(".lixeira").exists());

        let mut moved = Store::open(new.clone()).unwrap();
        let ws = moved.load().unwrap();
        assert_eq!(ws.tabs[0].content, "conteúdo A");
        assert_eq!(ws.projects[0].name, "Loja");
        assert_eq!(moved.restore_trash("t2").unwrap().content, "conteúdo B");

        // pasta de destino que já tem notas não é sobrescrita
        let outra = Store::open(base.join("outra")).unwrap();
        outra.persist().unwrap();
        assert!(relocate(&moved, &base.join("outra")).is_err());
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn importar_e_exportar_aba() {
        let dir = tmp("import");
        let mut s = Store::open(dir.clone()).unwrap();
        s.create_project("p1", "Loja", "azul").unwrap();
        let a = s.import_tab("i1", "  guia   rápido ", "# Guia\n", Some("p1")).unwrap();
        let b = s.import_tab("i2", "guia rápido", "outro", Some("p1")).unwrap();
        assert_eq!(a.meta.name, "guia rápido");
        assert_eq!(b.meta.name, "guia rápido 2");
        assert_eq!(fs::read_to_string(dir.join(&a.meta.file)).unwrap(), "# Guia\n");

        let out = s.export_tab("i1", &dir.join("saida")).unwrap();
        assert_eq!(out, dir.join("saida.md"));
        assert_eq!(fs::read_to_string(out).unwrap(), "# Guia\n");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn data_da_lixeira_e_atalhos_aceitos() {
        assert_eq!(stamp(0), "19700101-000000");
        assert_eq!(stamp(1_700_000_000), "20231114-221320");
        assert_eq!(stamp(951_782_400), "20000229-000000"); // ano bissexto
        assert!(valid_trash_file("20231114-221320-nota_x.md"));
        assert!(!valid_trash_file("../x.md") && !valid_trash_file("a/b.md") && !valid_trash_file("Nota.md"));
        for ok in ["CommandOrControl+Shift+Space", "Ctrl+Alt+K", "Ctrl+Shift+1", "Alt+F5", "Ctrl+Shift+Space"] {
            assert!(Shortcut::from_str(ok).is_ok(), "{ok} deveria ser aceito");
        }
        assert!(Shortcut::from_str("Ctrl+Shift+").is_err());
        assert!(Shortcut::from_str("nada").is_err());
    }

    #[test]
    fn ambientes_com_variaveis_validam_e_persistem() {
        let dir = tmp("ambientes");
        let mut s = Store::open(dir.clone()).unwrap();
        let var = |k: &str, v: &str, d: &str| Variable { key: k.into(), value: v.into(), description: d.into(), secret: false, locked: false };
        let envs = vec![
            Environment {
                id: "e1".into(),
                name: "  Desenvolvimento ".into(),
                variables: vec![
                    var("HOST", "dev.cleandev.com.br", "Host do ambiente de desenvolvimento"),
                    var("host", "repetida", ""), // mesma chave sem diferenciar maiúsculas: descartada
                    var("com espaço", "x", ""),  // chave inválida: descartada
                    var("", "sem chave", ""),
                    var("api.base-url", "https://dev/api", ""),
                ],
            },
            Environment { id: "e2".into(), name: "desenvolvimento".into(), variables: vec![] }, // nome repetido
            Environment { id: "e3".into(), name: "Produção".into(), variables: vec![var("HOST", "cleandev.com.br", "")] },
            Environment { id: "../x".into(), name: "id ruim".into(), variables: vec![] },
        ];
        s.save_environments(envs).unwrap();
        s.save_ui(Ui { env: Some("e3".into()), ..Ui::default() }).unwrap();

        let ws = Store::open(dir.clone()).unwrap().load().unwrap();
        assert_eq!(ws.environments.len(), 2);
        assert_eq!(ws.environments[0].name, "Desenvolvimento");
        let keys: Vec<_> = ws.environments[0].variables.iter().map(|v| v.key.as_str()).collect();
        assert_eq!(keys, ["HOST", "api.base-url"]);
        assert_eq!(ws.environments[0].variables[0].value, "dev.cleandev.com.br");
        assert_eq!(ws.environments[0].variables[0].description, "Host do ambiente de desenvolvimento");
        assert_eq!(ws.ui.env.as_deref(), Some("e3"));

        // excluir o ambiente ativo limpa a seleção
        let mut s = Store::open(dir.clone()).unwrap();
        let keep: Vec<_> = s.index.environments.iter().filter(|e| e.id != "e3").cloned().collect();
        s.save_environments(keep).unwrap();
        assert_eq!(s.index.ui.env, None);
        let _ = fs::remove_dir_all(dir);
    }

    /// Cofre em memória (compartilhável entre "aberturas" do app) para os testes.
    #[derive(Clone, Default)]
    struct MemStore(std::sync::Arc<Mutex<HashMap<String, String>>>);

    impl SecretStore for MemStore {
        fn get(&self, id: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(id).cloned())
        }
        fn set(&self, id: &str, v: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(id.into(), v.into());
            Ok(())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(id);
            Ok(())
        }
    }

    /// Cofre que sempre falha (ex.: Linux sem Secret Service).
    struct BrokenStore;

    impl SecretStore for BrokenStore {
        fn get(&self, _: &str) -> Result<Option<String>, String> {
            Err("cofre indisponível".into())
        }
        fn set(&self, _: &str, _: &str) -> Result<(), String> {
            Err("cofre indisponível".into())
        }
        fn delete(&self, _: &str) -> Result<(), String> {
            Err("cofre indisponível".into())
        }
    }

    fn var(key: &str, value: &str, secret: bool) -> Variable {
        Variable { key: key.into(), value: value.into(), description: String::new(), secret, locked: false }
    }

    /// Todo o conteúdo de todos os arquivos da pasta, para provar que o segredo não está lá.
    fn everything_on_disk(dir: &Path) -> String {
        let mut all = String::new();
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                all.push_str(&everything_on_disk(&path));
            } else {
                all.push_str(&String::from_utf8_lossy(&fs::read(&path).unwrap()));
            }
        }
        all
    }

    #[test]
    fn segredo_fica_no_cofre_e_nunca_em_arquivo() {
        let dir = tmp("segredos");
        let cofre = MemStore::default();
        let mut s = Store::open_with(dir.clone(), Box::new(cofre.clone())).unwrap();
        s.create_tab("t1", "Nota", None).unwrap();
        s.save_tab("t1", "psql -W {{senha_db}}").unwrap();
        let env = |vars: Vec<Variable>| vec![Environment { id: "e1".into(), name: "Dev".into(), variables: vars }];

        s.save_environments(env(vec![var("HOST", "dev.local", false), var("SENHA_DB", "s3gredo!", true)])).unwrap();
        assert_eq!(cofre.0.lock().unwrap().get("env/e1/senha_db").map(String::as_str), Some("s3gredo!"));
        assert!(!everything_on_disk(&dir).contains("s3gredo!"), "o segredo apareceu em arquivo");
        assert!(everything_on_disk(&dir).contains("dev.local"));
        assert!(everything_on_disk(&dir).contains("\"secret\": true"));

        // reabrir devolve o valor lido do cofre, e a variável comum continua no json
        let reopened = Store::open_with(dir.clone(), Box::new(cofre.clone())).unwrap().load().unwrap();
        let vars = &reopened.environments[0].variables;
        assert_eq!((vars[0].value.as_str(), vars[0].secret), ("dev.local", false));
        assert_eq!((vars[1].value.as_str(), vars[1].secret, vars[1].locked), ("s3gredo!", true, false));

        // trocar o valor, renomear a chave e desmarcar o segredo: o cofre acompanha
        s.save_environments(env(vec![var("SENHA_DB", "novo!", true)])).unwrap();
        assert_eq!(cofre.0.lock().unwrap()["env/e1/senha_db"], "novo!");
        s.save_environments(env(vec![var("SENHA", "novo!", true)])).unwrap();
        assert!(cofre.0.lock().unwrap().contains_key("env/e1/senha"));
        assert!(!cofre.0.lock().unwrap().contains_key("env/e1/senha_db"));
        s.save_environments(env(vec![var("SENHA", "agora-comum", false)])).unwrap();
        assert!(cofre.0.lock().unwrap().is_empty());
        assert!(everything_on_disk(&dir).contains("agora-comum")); // não é mais segredo: vive no json

        // excluir o ambiente (ou a variável) limpa o cofre; valor longo demais é recusado, não cortado
        s.save_environments(env(vec![var("TOKEN", "abc", true)])).unwrap();
        assert_eq!(cofre.0.lock().unwrap().len(), 1);
        assert!(s.save_environments(env(vec![var("TOKEN", &"x".repeat(1001), true)])).is_err());
        assert_eq!(cofre.0.lock().unwrap()["env/e1/token"], "abc");
        s.save_environments(vec![]).unwrap();
        assert!(cofre.0.lock().unwrap().is_empty());

        // um segredo com valor escrito à mão no workspace.json é descartado ao abrir
        fs::write(
            dir.join("workspace.json"),
            r#"{"version":2,"environments":[{"id":"e1","name":"Dev","variables":[{"key":"K","value":"vazou","secret":true}]}]}"#,
        )
        .unwrap();
        let aberto = Store::open_with(dir.clone(), Box::new(MemStore::default())).unwrap();
        assert_eq!(aberto.index.environments[0].variables[0].value, "");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn cofre_indisponivel_nao_vira_texto_puro_nem_apaga_nada() {
        let dir = tmp("cofre-off");
        let cofre = MemStore::default();
        cofre.set("env/e1/senha", "guardada").unwrap();
        let envs = |v: Vec<Variable>| vec![Environment { id: "e1".into(), name: "Dev".into(), variables: v }];
        let mut s = Store::open_with(dir.clone(), Box::new(cofre.clone())).unwrap();
        s.save_environments(envs(vec![var("SENHA", "guardada", true)])).unwrap();

        // o cofre cai: a variável chega ao front sem valor e marcada como "locked"
        let mut off = Store::open_with(dir.clone(), Box::new(BrokenStore)).unwrap();
        let ws = off.load().unwrap();
        let v = &ws.environments[0].variables[0];
        assert!(v.secret && v.locked && v.value.is_empty());

        // salvar outras coisas com o cofre fora funciona e não toca no segredo "locked"
        let mut edited = ws.environments.clone();
        edited[0].variables.push(var("HOST", "h", false));
        off.save_environments(edited).unwrap();
        assert_eq!(cofre.0.lock().unwrap()["env/e1/senha"], "guardada");

        // tentar gravar um segredo novo com o cofre fora falha, sem cair para texto puro
        let nova = envs(vec![var("SENHA", "guardada", true), var("OUTRA", "plain-text-nao", true)]);
        assert!(off.save_environments(nova).is_err());
        assert!(!everything_on_disk(&dir).contains("plain-text-nao"));
        let _ = fs::remove_dir_all(dir);
    }

    /// Usa o cofre real do sistema; rode no Windows/macOS com: cargo test -- --ignored
    #[test]
    #[ignore]
    fn cofre_real_do_sistema() {
        let id = format!("teste/{}", std::process::id());
        let k = KeyringStore;
        assert_eq!(k.get(&id).unwrap(), None);
        k.set(&id, "valor ç ã 🔑").unwrap();
        assert_eq!(k.get(&id).unwrap().as_deref(), Some("valor ç ã 🔑"));
        k.delete(&id).unwrap();
        assert_eq!(k.get(&id).unwrap(), None);
        k.delete(&id).unwrap(); // apagar o que não existe não é erro
    }
}
