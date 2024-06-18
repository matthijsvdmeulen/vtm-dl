import { launch } from 'puppeteer';
import { XMLParser } from 'fast-xml-parser';
import getWvKeys from './getwvkeys.js';
import { existsSync, mkdirSync, readFileSync, writeFile, promises } from 'fs';
import { unlink } from 'fs/promises';
import { spawn } from 'child_process';
import { resolve, join } from "path";

const options = {
    ignoreAttributes: false,
    removeNSPrefix: true
};
const parser = new XMLParser(options);

const WidevineProxyUrl = 'https://lic.drmtoday.com/license-proxy-widevine/cenc/?specConform=true';

//set as environment variable or replace with your own key
const authKey = process.env.AUTH_KEY || "";
const email = process.env.VTM_EMAIL || "";
const password = process.env.VTM_PASSW || "";
const videoPath = resolve("./videos") + "/";

if (!existsSync(videoPath)) {
    mkdirSync(videoPath);
    mkdirSync(videoPath + '/keys');
}

let browser = null;

// enter the vtm go show name (from url) and download all episodes from the chosen season.

getAllEpisodesFromSeason("milo~e38295bf-280c-43b5-a1d1-4e41904a367f", "seizoen-1").then((urls) => {
    getEpisodes(urls);
});

// getEpisodes([
//     "https://www.vtmgo.be/vtmgo/afspelen/adf9caa7-ee22-4608-a719-efef8c5ad27f",
//     "https://www.vtmgo.be/vtmgo/afspelen/46023a39-ae3f-4536-a940-6ad9896f846d",
//     "https://www.vtmgo.be/vtmgo/afspelen/99cbc73d-acaa-43b6-b208-b76978244418",
//     "https://www.vtmgo.be/vtmgo/afspelen/3f9482eb-f0b4-4880-8bf3-90825d8bd723"
// ]).then((result) => {
//     console.log(result);
// });

// getEpisode("https://www.vtmgo.be/vtmgo/afspelen/46023a39-ae3f-4536-a940-6ad9896f846d").then((result) => {
//     console.log(result);
// });

async function vtmLogin() {
    // check if browser is already running
    if (browser === null) {
        browser = await launch({headless: false});
    }

    console.log('Running tests..');
    const page = await browser.newPage();

    await page.goto('https://www.vtmgo.be/vtmgo');

    await sleep(500);
    await page.waitForSelector('>>> #pg-accept-btn');
    await page.click('>>> #pg-accept-btn');

    await page.waitForSelector('label[for=\'user-dropdown-trigger-mobile\']');
    await page.click('label[for=\'user-dropdown-trigger-mobile\']');

    await page.waitForSelector('.user-dropdown__item a[js-module=\'loginRedirect\']');
    await page.click('.user-dropdown__item a[js-module=\'loginRedirect\']');

    await page.waitForSelector('#username');
    await page.$eval('#username', (el, secret) => el.value = secret, email);
    await sleep(500);
    await page.waitForSelector('button[type=\'submit\']');
    await page.click('button[type=\'submit\']');

    await page.waitForSelector('#password');
    await page.$eval('#password', (el, secret) => el.value = secret, password);
    await sleep(500);
    await page.waitForSelector('button[type=\'submit\']');
    await page.click('button[type=\'submit\']');

    try {
        await page.waitForNetworkIdle();
    } catch (TimeoutError) {
        // keep going
    }

    await page.close();

}

async function getEpisode(url) {
    const promiseLogin = vtmLogin();
    await promiseLogin;
    const result = await getInformation(url);
    await browser.close();
    return downloadFromID(result);
}

async function getAllEpisodesFromSeason(show, season = 0) {
    if (browser == null) {
        browser = await launch({headless: false});
    }
    const page = await browser.newPage();

    console.log(`${show} - ${season}`);

    await page.goto(`https://www.vtmgo.be/vtmgo/${show}/${season}`);

    await page.waitForSelector('>>> #pg-accept-btn');
    await page.click('>>> #pg-accept-btn');

    await page.waitForSelector('x-swimlane__scroller[aria-label=\'Afleveringen\']');
    const urls = await page.evaluate(() => {
        let urllist = [];
        document.querySelectorAll('x-swimlane__scroller[aria-label=\'Afleveringen\'] a').forEach(item => urllist.push(item.href));
        return [...new Set(urllist)];
    });

    if (urls === null) {
        console.log('Error retrieving episode data');
        return null;
    }

    await browser.close();
    browser = null;

    return urls;
}


async function getEpisodes(urls) {
    const promiseLogin = vtmLogin();
    let informationList = [];
    await promiseLogin;
    for (const vtm_url of urls) {
        informationList.push(getInformation(vtm_url));
    }

    const list = await Promise.all(informationList);
    await browser.close();

    return downloadMulti(list, true);
}

async function downloadMulti(InformationList, runParallel = false) {
    if (runParallel === true) {
        let downloadPromises = [];
        for (const information of InformationList) {
            downloadPromises.push(downloadFromID(information));
        }
        return await Promise.all(downloadPromises);
    }

    let result = [];
    for (const information of InformationList) {
        result.push(await downloadFromID(information));
    }
    return result;
}

async function getInformation(url) {
    let tries = 0;
    while (tries <= 3) {
        tries++;
        try {
            const page = await browser.newPage();

            await page.goto(url);
            if (page.url() === "https://www.vtmgo.be/vtmgo") {
                await page.close();
                console.log(`Error wrong episode ID ${url}`);
                return null;
            }

            if(await page.$("div.error")) {
                await page.close();
                console.log('Error content probably needs VTM Go Plus subscription');
                return null;
            }

            // const iframe = await page.waitForSelector(`#iframe-${id}`);
            await page.waitForSelector(`.player__mediaElement`);
            const filename = await generateFileName(page);

            console.log(`${filename} - ${url}`);
            const keyPath = getKeyPath(filename);

            if (await fileExists(keyPath)) {
                await page.close();
                console.log('information already gathered');
                return JSON.parse(readFileSync(keyPath, 'utf8'));
            }

            const mpdPromise = page.waitForResponse((response) => {
                if (response.url().includes('.mpd')) {
                    return response;
                }
            });

            // wait for post request that ends with 'stream-link'
            const streamResponsePromise = page.waitForResponse((response) => {
                if (response.url().includes('play-config') && response.request().method() === 'POST') {
                    return response;
                }
            });

            // reload the page to get the stream link
            await page.reload();
            const streamData = await (await streamResponsePromise).json();

            let x_custom_data = "";
            try {
                x_custom_data = streamData['video']['streams'][1]['drm']['com.widevine.alpha']['drmtoday']['authToken'] || "";
            } catch (TypeError) {}

            const mpdData = parser.parse(await (await mpdPromise).text());

            let pssh = "";
            let vidkid = "";
            let audkid = "";
            // check if the mpdData contains the necessary information
            if ('ContentProtection' in mpdData["MPD"]["Period"]["AdaptationSet"][0]["Representation"]) {
                pssh = mpdData["MPD"]["Period"]["AdaptationSet"][0]["Representation"]["ContentProtection"][1].pssh || "";
                mpdData["MPD"]["Period"]["AdaptationSet"].forEach(set => {
                    try {
                        if(set["Representation"]["@_height"] === "1080") {
                            vidkid = set["Representation"]["ContentProtection"][0]["@_default_KID"].trim().replaceAll('-', '').toLowerCase();
                        }
                    } catch(e) {};
                    try {
                        if(set["Label"] === "Stereo") {
                            audkid = set["Representation"]["ContentProtection"][0]["@_default_KID"].trim().replaceAll('-', '').toLowerCase();
                        }
                    } catch(e) {};
                });
            }

            const information = {
                "filename": filename,
                "pssh": pssh,
                "vidkid": vidkid,
                "audkid": audkid,
                "x_custom_data": x_custom_data,
                "mpdUrl": streamData['video']['streams'][1]['url'],
                "wideVineKeyResponse": null
            };

            //if pssh and x_custom_data are not empty, get the keys
            if (pssh.length !== 0 && x_custom_data.length !== 0) {
                information.wideVineKeyResponse = ((await getWVKeys(pssh, x_custom_data)));
            } else {
                console.log('probably no drm');
            }

            await writeKeyFile(keyPath, JSON.stringify(information));

            page.close();
            console.log(information);
            return information;
        } catch (e) {
            console.log(`Error retrieving information, try ${tries}/3 (${url})`);
            console.log(e);
            await sleep(5000);
            try {
                await page.close();
            } catch (E) {
            }
        }
    }
}

function getKeyPath(filename) {
    return join(videoPath, '/keys/', filename + '.json');
}

async function writeKeyFile(path, data) {
    await writeFile(path, data, 'utf8', (err) => {
        if (err) {
            console.log(`Error writing file: ${err}`);
        } else {
            console.log(`${path} is written successfully!`);
        }

    });

}

async function deleteFile(path) {
    // check if file exists
    if (await fileExists(path)) {
        try {
            await unlink(path.toString());
            console.log(`successfully deleted ${path}`);
        } catch (error) {
            console.error('there was an error:', error.message);
        }
    } else {
        console.warn(`file ${path} does not exist`);
    }
}


async function downloadFromID(information) {
    if (information === null) {
        return null;
    }

    let filename = information.filename.toString();

    console.log(filename);

    const combinedFileName = videoPath + filename + '.mkv';
    if (await fileExists(combinedFileName)) {
        console.log("File already downloaded");
        return combinedFileName;
    }


    console.log(information);

    filename = await downloadMpd(information.mpdUrl.toString(), filename);

    console.log(filename);

    let keys = null;

    if (information.wideVineKeyResponse !== null) {
        keys = information.wideVineKeyResponse;
    }

    return await decryptFiles(filename, keys, information.vidkid, information.audkid);
}


async function decryptFiles(filename, keys, vidkid, audkid) {
    //console.log(videoPath);
    let encryptedFilename = 'encrypted#' + filename;

    const mp4File = videoPath + encryptedFilename + '.mp4';
    const m4aFile = videoPath + encryptedFilename + '.m4a';

    let newkeys = {};
    if (keys != null) {
        keys.forEach(key => newkeys[key.split(':')[0]] = key.split(':')[1]);
    }
    const resultFileName = await combineVideoAndAudio(filename, mp4File, m4aFile, newkeys, vidkid, audkid);

    await sleep(1000);

    if (await fileExists(resultFileName)) {
        await deleteFile(mp4File);
        await deleteFile(m4aFile);
    }

    return resultFileName;
}

async function runCommand(command, args, result) {
    return new Promise((success, reject) => {
        const cmd = spawn(command, args);
        const stdout = cmd.stdout;
        let stdoutData = null;

        stdout.on('end', () => {
            console.log(`finished: ${command} ${args}`);
            success(result);
        });

        stdout.on('readable', () => {
            stdoutData = stdout.read();
            if (stdoutData != null) console.log(stdoutData + `\t [${result}]`);
        });

        cmd.stderr.on('error', (data) => {
            reject(data);
        });

    });
}

async function combineVideoAndAudio(filename, video, audio, keys, vidkid, audkid) {
    const combinedFileName = videoPath + filename + '.mkv';
    let args = ['-i', video, '-i', audio, '-c', 'copy', combinedFileName];
    if (keys != null) {
        args = ['-decryption_key', keys[vidkid], '-i', video, '-decryption_key', keys[audkid], '-i', audio, '-c', 'copy', combinedFileName];
    }
    return runCommand('ffmpeg', args, combinedFileName);
}

async function downloadMpd(mpdUrl, filename) {
    const filenameFormat = 'encrypted#' + filename + '.%(ext)s';
    const args = ['--allow-u', '--downloader', 'aria2c', '-f', 'bv,ba', '-P', videoPath, '-o', filenameFormat, mpdUrl];
    return runCommand('yt-dlp', args, filename);
}


function getWVKeys(pssh, x_custom_data) {
    console.log('getting keys from website');

    return new Promise((success, reject) => {
        if (authKey === "") {
            reject('no auth key');
        }
        const js_getWVKeys = new getWvKeys(pssh, WidevineProxyUrl, authKey, x_custom_data);
        js_getWVKeys.getWvKeys().then((result) => {
            success(result);
        });
    });
}

async function generateFileName(page) {
    const rawTitle = page.$eval('h1.lfvp-player__title', el => el["innerText"]);

    let filename = "";

    filename += (await rawTitle);

    // remove illegal characters from filename
    filename = filename.replace(/[/\\?%*:|"<>]/g, '#');

    return filename;
}


const fileExists = async path => !!(await promises.stat(path).catch(() => false));

const sleep = (milliseconds) => {
    return new Promise(success => setTimeout(success, milliseconds));
};
