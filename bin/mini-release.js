/*
 * All-in-one interactive N Air release script.
 */

const fs = require('fs');
const path = require('path');
const OctoKit = require('@octokit/rest');

let sh;
let moment;
let inq;
let colors;
let ProgressBar;
let yaml;

try {
    sh = require('shelljs');
    moment = require('moment');
    inq = require('inquirer');
    colors = require('colors/safe');
    ProgressBar = require('progress');
    yaml = require('js-yaml');
} catch (e) {
    if (e.message.startsWith('Cannot find module')) {
        throw new Error(`先に\`yarn install\`を実行する必要があります: ${e.message}`);
    }
    throw e;
}

/**
 * CONFIGURATION
 */

function info(msg) {
    sh.echo(colors.magenta(msg));
}

function error(msg) {
    sh.echo(colors.red(`ERROR: ${msg}`));
}

function executeCmd(cmd, options) {
    const result = sh.exec(cmd, options);

    if (result.code !== 0) {
        error(`Command Failed >>> ${cmd}`);
        sh.exit(1);
    }

    // returns {code:..., stdout:..., stderr:...}
    return result;
}

async function confirm(msg, defaultValue = true) {
    const result = await inq.prompt({
        type: 'confirm',
        name: 'conf',
        message: msg,
        'default': defaultValue
    });

    return result.conf;
}

function checkEnv(varName) {
    if (!process.env[varName]) {
        error(`Missing environment variable ${varName}`);
        sh.exit(1);
    }
}

function generateNewVersion(previousTag, now = Date.now()) {
    // previous tag should be following rule:
    //  v{major}.{minor}.{yyyymmdd}-{ord}

    const re = /v(\d+)\.(\d+)\.(\d{8})-(\d+)/g;
    let result = re.exec(previousTag);
    if (!result || result.length < 5) {
        result = ['', '0', '1', '', '1'];
    }
    let [matched, major, minor, date, ord] = result;

    const today = moment(now).format('YYYYMMDD');
    if (date === today) {
        ++ord;
    } else {
        date = today;
        ord = 1;
    }
    return `${major}.${minor}.${date}-${ord}`;
}

function generateNotesTsContent(version, title, notes) {
    const patchNote = `import { IPatchNotes } from '.';

export const notes: IPatchNotes = {
  version: '${version}',
  title: '${title}',
  notes: [
${notes.trim().split('\n').map(s => `    '${s}'`).join(',\n')}
  ]
};
`;
    info(`patch-note: '${patchNote}'`);
    return patchNote;
}

function splitToLines(lines) {
    if (typeof lines === 'string') {
        lines = lines.split(/\r?\n/g);
    }
    return lines;
}

function readPatchNoteFile(patchNoteFileName) {
    try {
        const lines = splitToLines(fs.readFileSync(patchNoteFileName, {encoding: 'utf8'}));
        const version = lines.shift();
        return {
            version,
            lines
        };
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        return {
            version: '',
            lines: []
        };
    }
}

function writePatchNoteFile(patchNoteFileName, version, lines) {
    lines = splitToLines(lines);
    const body = [version, ...lines].join('\n');
    fs.writeFileSync(patchNoteFileName, body);
}

function getTagCommitId(tag) {
    return executeCmd(`git rev-parse -q --verify "refs/tags/${tag}" || cat /dev/null`, {silent: true}).stdout;
}

async function collectPullRequestMerges({octokit, owner, repo}, previousTag) {
    const merges = executeCmd(`git log --oneline --merges ${previousTag}..`, {silent: true}).stdout;

    let promises = [];
    for (const line of merges.split(/\r?\n/)) {
        info(line);
        const pr = line.match(/.*Merge pull request #([0-9]*).*/);
        if (!pr || pr.length < 2) {
            continue;
        }
        const number = parseInt(pr[1], 10);
        info(number);
        promises.push(octokit.pullRequests.get({owner, repo, number}).catch(e => { info(e); return {data: {}}}));
    }

    return Promise.all(promises).then(results => {
        let summary = [];
        for (const result of results) {
            const data = result.data;
            if ('title' in data) {
                summary.push(`${data.title} (#${data.number}) by ${data.user.login}\n`);
            }
        }
        return summary.join('');
    });
}

/**
 * This is the main function of the script
 */
async function runScript() {
    info(colors.magenta('|----------------------------------|'));
    info(colors.magenta('| N Air Interactive Release Script |'));
    info(colors.magenta('|----------------------------------|'));

    const githubApiServer = 'https://api.github.com';

    const organization = 'n-air-app';
    const repository = 'n-air-app';
    const remote = 'origin';

    const targetBranch = 'n-air_development';
    const draft = true;
    const prerelease = true;

    const generateNoteTs = true; // generate note.ts from git logs

    const skipLocalModificationCheck = false; // for DEBUG
    const skipBuild = false; // for DEBUG

    // Start by figuring out if this environment is configured properly
    // for releasing.
    checkEnv('CSC_LINK');
    checkEnv('CSC_KEY_PASSWORD');
    checkEnv('NAIR_LICENSE_API_KEY');
    checkEnv('NAIR_GITHUB_TOKEN');

    info(`check whether remote ${remote} exists`);
    executeCmd(`git remote get-url ${remote}`)

    if (skipLocalModificationCheck) {
        info('make sure there is nothing to commit on local directory');

        executeCmd('git status'); // there should be nothing to commit
        executeCmd('git diff -s --exit-code'); // and nothing changed
    }

    info('checking current branch...')
    const currentBranch = executeCmd('git rev-parse --abbrev-ref HEAD').stdout.trim()
    if (currentBranch !== targetBranch) {
        if (!await confirm(`current branch '${currentBranch}' is not '${targetBranch}'. continue?`, false)) {
            sh.exit(1);
        }
    }

    info('pulling fresh repogitory...')
    executeCmd(`git pull`);

    info('checking current tag...');
    const previousTag = executeCmd('git describe --tags --abbrev=0').stdout.trim();

    const baseDir = executeCmd('git rev-parse --show-cdup', {silent: true}).stdout.trim();

    let defaultVersion = generateNewVersion(previousTag);
    let notes = '';

    info('checking patch-note.txt...');
    const patchNoteFileName = `${baseDir}patch-note.txt`;
    const patchNote = readPatchNoteFile(patchNoteFileName);
    if (patchNote.version) {
        if (patchNote.version === defaultVersion || !getTagCommitId(patchNote.version)) {
            defaultVersion = patchNote.version;
            notes = patchNote.lines.join('\n');
            info(`${patchNoteFileName} loaded: ${defaultVersion}\n${notes}`);
        } else {
            info(`${patchNoteFileName} 's version ${patchNote.version} already exists.`);
        }
    } else {
        info(`${patchNoteFileName} not found.`);
    }

    const newVersion = (await inq.prompt({
        type: 'input',
        name: 'newVersion',
        message: 'What should the new version number be?',
        default: defaultVersion
    })).newVersion;

    const newTag = `v${newVersion}`;
    if (getTagCommitId(newTag)) {
        error(`tag ${newTag} already exists!`);
        sh.exit(1);
    }

    if (!notes) {
        // get pull request description from github.com
        const github = new OctoKit({baseUrl: 'https://api.github.com'});
        github.authenticate({
            type: 'token',
            token: process.env.NAIR_GITHUB_TOKEN
        });
        const prMerges = await collectPullRequestMerges({
            octokit: github,
            owner: 'n-air-app',
            repo: 'n-air-app'
        }, previousTag);
        info(prMerges);

        const merges = executeCmd('git log -1 --merges --pretty=format:%P', {silent: true}).stdout.trim();
        const mergeBase = executeCmd(`git merge-base --octopus ${merges} ${previousTag}`, {silent: true}).stdout.trim();
        notes = prMerges + executeCmd(`git log --oneline --graph --decorate ${mergeBase}.. --boundary`).stdout;

        writePatchNoteFile(patchNoteFileName, newVersion, notes);
        info(`generated ${patchNoteFileName}.`);
        if (await confirm(`Do you want to edit ${patchNoteFileName}?`, true)) sh.exit(0);
    } else if (newVersion !== defaultVersion) {
        writePatchNoteFile(patchNoteFileName, newVersion, notes);
        info(`updated version ${newVersion} to  ${patchNoteFileName}.`);
    }

    if (draft) {
        info('draft is true.');
    }
    if (prerelease) {
        info(`prerelease is true.`);
    }
    if (!await confirm(`Are you sure you want to release as version ${newVersion}?`, false)) sh.exit(0);

    if (!generateNoteTs) {
        info('skipping to generate notes.ts...');
    } else {
        const noteFilename = `${baseDir}app/services/patch-notes/notes.ts`;
        const patchNote = generateNotesTsContent(newVersion, newVersion, notes);

        fs.writeFileSync(noteFilename, patchNote);
        info(`generated patch-note file: ${noteFilename}.`)
    }

    // update package.json with newVersion and git tag
    executeCmd(`yarn version --new-version=${newVersion}`);

    if (skipBuild) {
        info('SKIP build process since skipBuild is set...');
    } else {
        if (!await confirm('skip cleaning node_modules?')) {
            // clean
            info('Removing old packages...');
            sh.rm('-rf', 'node_modules');
        }

        info('Installing yarn packages...');
        executeCmd('yarn install');

        info('Compiling assets...');
        executeCmd('yarn compile:production');

        info('Making the package...');
        executeCmd('yarn package');
    }

    info('Pushing to the repository...')
    executeCmd(`git push ${remote} ${targetBranch}`);
    executeCmd(`git push ${remote} ${newTag}`);

    info(`version: ${newVersion}`);

    const distDir = path.resolve('.', 'dist');
    const latestYml = path.join(distDir, 'latest.yml');
    const parsedLatestYml = yaml.safeLoad(fs.readFileSync(latestYml));

    // add releaseNotes into latest.yml
    parsedLatestYml.releaseNotes = notes;
    fs.writeFileSync(latestYml, yaml.safeDump(parsedLatestYml));

    const binaryFile = parsedLatestYml.path;
    const binaryFilePath = path.join(distDir, binaryFile);
    if (!fs.existsSync(binaryFilePath)) {
        error(`Counld not find ${path.resolve(binaryFilePath)}`);
        sh.exit(1);
    }
    const blockmapFile = binaryFile + '.blockmap';
    const blockmapFilePath = path.join(distDir, blockmapFile);
    if (!fs.existsSync(blockmapFilePath)) {
        error(`Counld not find ${path.resolve(blockmapFilePath)}`);
        sh.exit(1);
    }

    executeCmd(`ls -l ${binaryFilePath} ${blockmapFilePath} ${latestYml}`);

    // upload to the github directly via GitHub API...

    const octokit = OctoKit({
        baseUrl: githubApiServer
    });

    octokit.authenticate({
        type: 'token',
        token: process.env.NAIR_GITHUB_TOKEN
    });

    info(`creating release ${newTag}...`);
    const result = await octokit.repos.createRelease({
        owner: organization,
        repo: repository,
        tag_name: newTag,
        name: newTag,
        body: notes,
        draft,
        prerelease
    });

    info(`uploading ${latestYml}...`);
    const ymlResult = await octokit.repos.uploadAsset({
        url: result.data.upload_url,
        file: fs.createReadStream(latestYml),
        name: path.basename(latestYml),
        contentLength: fs.statSync(latestYml).size,
        contentType: 'application/json',
    });

    info(`uploading ${blockmapFilePath}...`);
    await octokit.repos.uploadAsset({
        url: result.data.upload_url,
        name: blockmapFile,
        file: fs.createReadStream(blockmapFilePath),
        contentLength: fs.statSync(blockmapFilePath).size,
        contentType: 'application/octet-stream',
    });

    info(`uploading ${binaryFile}...`);
    await octokit.repos.uploadAsset({
        url: result.data.upload_url,
        name: binaryFile,
        file: fs.createReadStream(binaryFilePath),
        contentLength: fs.statSync(binaryFilePath).size,
        contentType: 'application/octet-stream',
    });

    if (draft) {
        // open release edit page on github
        const editUrl = result.data.html_url.replace('/tag/', '/edit/');
        executeCmd(`start ${editUrl}`);

        info(`finally, release Version ${newVersion} on the browser!`);
    } else {
        // open release page on github
        executeCmd(`start ${result.data.html_url}`);

        info(`Version ${newVersion} is released!`);
    }
    // done.
}

runScript().then(() => {
    sh.exit(0);
});
