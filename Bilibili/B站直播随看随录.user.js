// ==UserScript==
// @name         B站直播随看随录
// @namespace    http://tampermonkey.net/
// @version      0.4
// @description  无需打开弹幕姬，必要时直接录制的快速切片工具
// @author       Eric Lam
// @compatible   Chrome(94.0)
// @compatible   Firefox(91.0)
// @compatible   Edge(94.0)
// @license      MIT
// @include      /https?:\/\/live\.bilibili\.com\/(blanc\/)?\d+\??.*/
// @require      https://cdn.jsdelivr.net/npm/jquery@3.5.1/dist/jquery.min.js
// @grant        none
// ==/UserScript==


class StreamUrlGetter {

    constructor() {
        if (this.constructor == StreamUrlGetter){
            throw new Error('cannot initialize abstract class')
        }
    }

    async getUrl(roomid, qn = 10000){
    }

}

let enableIndexedDB = false;
let limit1gb = false;

(async function() {
    'use strict';
    const uidRegex = /\/\/space\.bilibili\.com\/(?<id>\d+)\//g
    const roomLink =  $('.room-owner-username').attr('href')
    const uid = uidRegex.exec(roomLink)?.groups?.id

    const roomReg = /^\/(blanc\/)?(?<id>\d+)/
    let roomId = parseInt(roomReg.exec(location.pathname)?.groups?.id)

    let res = await fetcher('https://api.live.bilibili.com/room/v1/Room/room_init?id='+roomId)
    roomId = res.data.room_id

    console.log('正在测试获取B站直播流')

    if (res.data.live_status != 1){
        console.log('此房间目前没有直播')
        return
    }

    // ========= indexdb 操作 =========================
    const key = `stream_record.${roomId}`

    if (window.indexedDB){
       try {
           await connect(key)
           enableIndexedDB = true
       }catch(err){
          console.error(err)
          alert(`連接資料庫時出現錯誤: ${err.message}, 没办法使用 IndexedDB。(尝试刷新?)`)
          closeDatabase()
       }
    }else{
        alert('你的瀏覽器不支援IndexedDB。')
    }

    if (!enableIndexedDB) {
        limit1gb = confirm('由于 IndexedDB 无法被使用，是否应该限制每次最多录制 1gb 视频以防止浏览器崩溃？')
    }

    // ======== 更改方式实作 , 如无法寻找可以更改别的 class =====
    const urlGetter = new RoomPlayInfo()
    // ===================================================

    const stream_urls = await urlGetter.getUrl(roomId)

    if (stream_urls.length == 0){
        console.warn('找不到合适的线路，已略过。')
        return
    }
    let real_url = undefined
    for (const stream_url of stream_urls){
        try {
           testUrlValid(stream_url)
           real_url = stream_url
           console.log(`找到可用线路: ${real_url}`)
           break
        }catch(err){
          console.warn(`测试线路 ${stream_url} 时出现错误: ${err}, 寻找下一个节点`)
          continue
        }
    }

    const rows = $('.rows-ctnr')
    rows.append(`<button id="record">开始录制</button>`)

    $('#record').on('click', () => {
       if (real_url === undefined){
           alert('没有可用的直播线路。')
           return
       }
        try {
            if (stop_record){
               startRecord(real_url).then(data => download_flv(data, `${roomId}.flv`))
            }else{
               stopRecord()
            }
        }catch(err){
          alert(`错误: ${err?.message ?? err}`)
          console.error(err)
        }
    })

})().catch(console.warn);

async function fetcher(url) {
    const res = await fetch(url)
    if (!res.ok){
        throw new Error(res.statusText)
    }

    const data = await res.json()
    console.debug(data)
    if (data.code != 0){
        throw new Error(`B站API请求错误: ${data.message}`)
    }
    return data
}


let stop_record = true
let timer_interval = -1

async function testUrlValid(url){
  const res = await fetch(url, { credentials: 'same-origin' })
  if (!res.ok){
     throw new Error(res.statusText)
  }
}


function toTimer(secs){
    let min = 0;
    let hr = 0;
    while(secs >= 60){
        secs -= 60
        min++
    }
    while (min >= 60){
        min -= 60
        hr++
    }
    const mu = min > 9 ? `${min}`: `0${min}`
    const ms = secs > 9 ? `${secs}` : `0${secs}`
    return `${hr}:${mu}:${ms}`
}

function isFlvHeader(buf) {
	if (!buf || buf.length < 4) {
		return false;
	}
	return buf[0] === 0x46 && buf[1] === 0x4c && buf[2] === 0x56 && buf[3] === 0x01;
}


let symbol = '🔴'
function startTimer(){
  let seconds = 0
  timer_interval = setInterval(() => {
     seconds += 1
     symbol = seconds % 2 == 0 ? '🔴' : '⚪'
  }, 1000)
}

function stopTimer() {
   clearInterval(timer_interval)
   $('#record')[0].innerText = '开始录制'
}

function round(float){
  return Math.round(float * 10) / 10
}

function formatSize(size) {
  const mb = round(size/1024/1024)
  if (mb > 1000){
     return `${round(mb / 1000).toFixed(1)}GB`
  }else{
     return `${mb.toFixed(1)}MB`
  }
}

async function startRecord(url) {
    await clearRecords() // 清空之前的记录
    const res = await fetch(url, { credentials: 'same-origin' })
    if (!res.ok){
        throw new Error(res.statusText)
    }
    startTimer()
    const reader = res.body.getReader();
    stop_record = false
    const chunks = [] // 不支援 indexeddb 时采用
    let size = 0
    console.log('录制已经开始...')
    while (!stop_record){
      const {done, value } = await reader.read()
      // 下播
      if (done){
         stop_record = true
         break
      }
      size += value.length
      $('#record')[0].innerText = `${symbol}录制中(${formatSize(size)})` // hover 显示目前录制视频大小
      const blob = new Blob([value], { type: 'application/octet-stream'})
      if (enableIndexedDB){
         await pushRecord(blob)
      }else{
         chunks.push(blob)
         if (limit1gb && round(size/1024/1024) > 1000){ // 采用非 indexeddb 且启用了限制 1gb 大小录制
            stop_record = true
            break
         }
      }
    }
    stopTimer()
    console.log('录制已中止。')
    if (enableIndexedDB){
       return await pollRecords()
    }else{
       return chunks
    }
}


async function stopRecord(){
   stop_record = true
}


function download_flv(chunks, file = 'test.flv'){
  if (!chunks || chunks.length == 0){
     console.warn('没有可以下载的资料')
     alert('没有可以下载的资料')
     return
  }
  const blob = new Blob(chunks, { type: 'video/x-flv' }, file)
  const url = window.URL.createObjectURL(blob)
  const a = document.createElement('a');
  a.style.display = "none";
  a.setAttribute("href", url);
  a.setAttribute("download", file);
  document.body.appendChild(a);
  a.click();
  window.URL.revokeObjectURL(url);
  a.remove();
}


class RoomPlayUrl extends StreamUrlGetter {

    async getUrl(roomid, qn = 10000){
        const stream_urls = []
        const res = await fetcher(`http://api.live.bilibili.com/room/v1/Room/playUrl?cid=${roomid}&qn=${qn}`)

        const durls = res.data.durl
        if (durls.length == 0){
            console.warn('没有可用的直播视频流')
            return stream_urls
        }

        for (const durl of durls){
            stream_urls.push(durl.url)
        }

        return stream_urls
    }
}


class RoomPlayInfo extends StreamUrlGetter {

    async getUrl(roomid, qn = 10000){
        const stream_urls = []
        const url = `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${roomid}&protocol=0,1&format=0,2&codec=0,1&qn=${qn}&platform=web&ptype=16`
       const res = await fetcher(url)

       if (res.data.is_hidden){
           console.warn('此直播間被隱藏')
           return stream_urls
       }

        if (res.data.is_locked){
            console.warn('此直播間已被封鎖')
            return stream_urls
        }

        if (res.data.encrypted && !res.data.pwd_verified){
            console.warn('此直播間已被上鎖')
            return stream_urls
        }

        const streams = res?.data?.playurl_info?.playurl?.stream ?? []
        if (streams.length == 0){
            console.warn('没有可用的直播视频流')
            return stream_urls
        }

        for (const index in streams){
            const st = streams[index]

            for (const f_index in st.format){
                const format = st.format[f_index]
                if (format.format_name !== 'flv'){
                    console.warn(`线路 ${index} 格式 ${f_index} 并不是 flv, 已经略过`)
                    continue
                }

                for (const c_index in format.codec){
                    const codec = format.codec[c_index]
                     if (codec.current_qn != qn){
                         console.warn(`线路 ${index} 格式 ${f_index} 编码 ${c_index} 的画质并不是 ${qn}, 已略过`)
                         continue
                     }
                     const accept_qn = codec.accept_qn
                     if (!accept_qn.includes(qn)){
                         console.warn(`线路 ${index} 格式 ${f_index} 编码 ${c_index} 不支援画质 ${qn}, 已略过`)
                         continue
                     }
                     const base_url = codec.base_url
                     for (const url_info of codec.url_info){
                         const real_url = url_info.host + base_url + url_info.extra
                         stream_urls.push(real_url)
                     }
                }

                return stream_urls
            }


        }
    }

}

// ========== indexdb ==========

function log(msg){
    console.log(`[IndexedDB] ${msg}`)
}

let db = undefined
const storeName = 'stream_record'

async function connect(key){
    return new Promise((res, rej) => {
        const open = window.indexedDB.open(key, 1)
        log('connecting to indexedDB')
        open.onerror = function(event){
            log('connection error: '+event.target.error.message)
            rej(event.target.error)
        }
        open.onsuccess = function(event){
            db = open.result
            log('connection success')
            createObjectStoreIfNotExist(db, rej)
            res(event)
        }
        open.onupgradeneeded = function(event) {
            db = event.target.result;
            log('connection success on upgrade needed')
            createObjectStoreIfNotExist(db, rej)
            res(event.target.error)
        }
    })

}

function closeDatabase(){
    db?.close()
}

async function drop(key){
    return new Promise((res, rej) => {
        const req = window.indexedDB.deleteDatabase(key);
        req.onsuccess = function () {
            log("Deleted database successfully");
            res()
        };
        req.onerror = function () {
            log("Couldn't delete database");
            rej(req.error)
        };
        req.onblocked = function () {
            log("Couldn't delete database due to the operation being blocked");
            rej(req.error)
        };
    })
}

function createObjectStoreIfNotExist(db, rej){
    if(!db) return
    try{
        if (!db.objectStoreNames.contains(storeName)) {
            log(`objectStore ${storeName} does not exist, creating new one.`)
            db.createObjectStore(storeName, { autoIncrement: true })
            log('successfully created.')
        }
    }catch(err){
        log('error while creating object store: '+err.message)
        rej(err)
    }
    db.onerror = function(event) {
        log("Database error: " + event.target.error.message);
    }
    db.onclose = () => {
        console.log('Database connection closed');
    }
}


async function pushRecord(object){
   return new Promise((res, rej)=>{
        if (!db){
            log('db not defined, so skipped')
            rej(new Error('db is not defined'))
        }
        try{
            const tran = db.transaction([storeName], 'readwrite')
            handleTrans(rej, tran)
            const s = tran.objectStore(storeName).add(object)
            s.onsuccess = (e) => {
                //log('pushing successful')
                res(e)
            }
            s.onerror = () => {
                log('error while adding byte: '+s.error.message)
                rej(s.error)
            }
        }catch(err){
            rej(err)
        }
   })
 }

 function handleTrans(rej, tran){
    tran.oncomplete = function(){
        //log('transaction completed')
    }
    tran.onerror = function(){
        log('transaction error: '+tran.error.message)
        rej(tran.error)
    }
 }

async function pollRecords(){
    const buffer = await listRecords()
    await clearRecords()
    return buffer
}

async function listRecords(){
   return new Promise((res, rej) => {
    if (!db){
        log('db not defined, so skipped')
        rej(new Error('db is not defined'))
      }
      try{
        const tran = db.transaction([storeName], 'readwrite')
        handleTrans(rej, tran)
        const cursors = tran.objectStore(storeName).openCursor()
        const records = []
        cursors.onsuccess = function(event){
           let cursor = event.target.result;
           if (cursor) {
              records.push(cursor.value)
              cursor.continue();
           }
           else {
             log("total bytes: "+records.length);
             res(records)
           }
        }
        cursors.onerror = function(){
            log('error while fetching data: '+cursors.error.message)
            rej(cursors.error)
        }
      }catch(err){
          rej(err)
      }
   })
 }

async function clearRecords(){
   return new Promise((res, rej) => {
        if (!db){
            log('db not defined, so skipped')
            rej(new Error('db is not defined'))
        }
       try{
            const tran = db.transaction([storeName], 'readwrite')
            handleTrans(rej, tran)
            const req = tran.objectStore(storeName).clear()
            req.onsuccess = (e) => {
            log('clear success')
            res(e)
            }
            req.onerror = () =>{
                log('error while clearing data: '+req.error.message)
                rej(req.error)
            }
       }catch(err){
           rej(err)
       }
   })
}

