/**
 * Saves the given files in the given folder via the Cozy API.
 *
 * @module saveFiles
 */
const bluebird = require('bluebird')
const path = require('path')
const requestFactory = require('./request')
const omit = require('lodash/omit')
const log = require('cozy-logger').namespace('saveFiles')
const cozy = require('./cozyclient')
const mimetypes = require('mime-types')
const errors = require('../helpers/errors')
const stream = require('stream')
const DEFAULT_TIMEOUT = Date.now() + 4 * 60 * 1000 // 4 minutes by default since the stack allows 5 minutes
const DEFAULT_CONCURRENCY = 1

const sanitizeEntry = function(entry) {
  delete entry.requestOptions
  delete entry.filestream
  return entry
}

const downloadEntry = function(entry, options) {
  const reqOptions = Object.assign(
    {
      uri: entry.fileurl,
      method: 'GET',
      jar: true
    },
    entry.requestOptions
  )

  const rq = requestFactory({
    json: false,
    cheerio: false,
    userAgent: true,
    jar: true
  })
  let filePromise = rq(reqOptions)

  if (options.contentType) {
    // the developper wants to foce the contentType of the document
    // we pipe the stream to remove headers with bad contentType from the request
    return filePromise.pipe(new stream.PassThrough())
  }

  // we have to do this since the result of filePromise is not a stream and cannot be taken by
  // cozy.files.create
  if (options.postProcessFile) {
    log(
      'warn',
      'Be carefull postProcessFile option is deprecated. You should use the filestream attribute in each entry instead'
    )
    return filePromise.then(data => options.postProcessFile(data))
  }
  return filePromise
}

const createFile = async function(entry, options) {
  const folder = await cozy.files.statByPath(options.folderPath)
  const createFileOptions = {
    name: getFileName(entry),
    dirID: folder._id
  }
  if (options.contentType) {
    createFileOptions.contentType = options.contentType
  }

  const toCreate = entry.filestream || downloadEntry(entry, options)
  let fileDocument = await cozy.files.create(toCreate, createFileOptions)

  // This allows us to have the warning message at the first run
  checkMimeWithPath(fileDocument.attributes.mime, fileDocument.attributes.name)

  checkFileSize(fileDocument)
  return fileDocument
}

const attachFileToEntry = function(entry, fileDocument) {
  entry.fileDocument = fileDocument
  return entry
}

const saveEntry = function(entry, options) {
  if (options.timeout && Date.now() > options.timeout) {
    const remainingTime = Math.floor((options.timeout - Date.now()) / 1000)
    log('info', `${remainingTime}s timeout finished for ${options.folderPath}`)
    throw new Error('TIMEOUT')
  }

  const filepath = path.join(options.folderPath, getFileName(entry))
  return cozy.files
    .statByPath(filepath)
    .then(file => {
      // check that the extension and mime type of the existing file in cozy match
      // if this is not the case, we redownload it
      const mime = file.attributes.mime
      if (!checkMimeWithPath(mime, filepath) || !checkFileSize(file)) {
        return cozy.files
          .trashById(file._id)
          .then(() => Promise.reject(new Error('BAD_DOWNLOADED_FILE')))
      }
      return file
    })
    .then(
      file => {
        return file
      },
      () => {
        log('debug', omit(entry, 'filestream'))
        logFileStream(entry.filestream)
        log('debug', `File ${filepath} does not exist yet or is not valid`)
        entry._cozy_file_to_create = true
        return createFile(entry, options)
      }
    )
    .then(file => {
      attachFileToEntry(entry, file)
      return entry
    })
    .then(sanitizeEntry)
    .then(entry => {
      return options.postProcess ? options.postProcess(entry) : entry
    })
    .catch(err => {
      if (getErrorStatus(err) === 413) {
        // the cozy quota is full
        throw new Error(errors.DISK_QUOTA_EXCEEDED)
      }
      log('warn', errors.SAVE_FILE_FAILED)
      log(
        'warn',
        err.message,
        `Error caught while trying to save the file ${
          entry.fileurl ? entry.fileurl : entry.filename
        }`
      )
      return entry
    })
}

/**
 * Saves the files given in the fileurl attribute of each entries
 *
 * You need the full permission on `io.cozy.files` in your manifest to use this function.
 *
 * - `files` is an array of `{ fileurl, filename }` :
 *
 *   + fileurl: The url of the file. This attribute is mandatory or
 *     this item will be ignored
 *   + filename : The file name of the item written on disk. This attribute is optional and as default value, the
 *     file name will be "smartly" guessed by the function. Use this attribute if the guess is not smart
 *   enough for you.
 *
 * - `fields` (string) is the argument given to the main function of your connector by the BaseKonnector.
 *      It especially contains a `folderPath` which is the string path configured by the user in
 *      collect/home
 *
 * - `options` (object) is optional. Possible options :
 *
 *   + `timeout` (timestamp) can be used if your connector needs to fetch a lot of files and if the
 *   stack does not give enough time to your connector to fetch it all. It could happen that the
 *   connector is stopped right in the middle of the download of the file and the file will be
 *   broken. With the `timeout` option, the `saveFiles` function will check if the timeout has
 *   passed right after downloading each file and then will be sure to be stopped cleanly if the
 *   timeout is not too long. And since it is really fast to check that a file has already been
 *   downloaded, on the next run of the connector, it will be able to download some more
 *   files, and so on. If you want the timeout to be in 10s, do `Date.now() + 10*1000`.
 *   You can try it in the previous code.
 *   + `contentType` (string) ex: 'application/pdf' used to force the contentType of documents when
 *   they are badly recognized by cozy.
 * @example
 * ```javascript
 * await saveFiles([{fileurl: 'https://...', filename: 'bill1.pdf'}], fields)
 * ```
 *
 * @alias module:saveFiles
 */
const saveFiles = async (entries, fields, options = {}) => {
  if (!entries || entries.length === 0) {
    log('warn', 'No file to download')
  }
  if (typeof fields !== 'object') {
    log(
      'debug',
      'Deprecation warning, saveFiles 2nd argument should not be a string'
    )
    fields = {
      folderPath: fields
    }
  }
  const saveOptions = {
    folderPath: fields.folderPath,
    timeout: options.timeout || DEFAULT_TIMEOUT,
    concurrency: options.concurrency || DEFAULT_CONCURRENCY,
    postProcess: options.postProcess,
    postProcessFile: options.postProcessFile,
    contentType: options.contentType
  }

  const canBeSaved = entry =>
    entry.fileurl || entry.requestOptions || entry.filestream

  let savedFiles = 0
  const savedEntries = []
  try {
    await bluebird.map(
      entries,
      async entry => {
        if (canBeSaved(entry)) {
          entry = await saveEntry(entry, saveOptions)
          if (entry && entry._cozy_file_to_create) {
            savedFiles++
            delete entry._cozy_file_to_create
          }
        }
        savedEntries.push(entry)
      },
      { concurrency: saveOptions.concurrency }
    )
  } catch (err) {
    if (err.message !== 'TIMEOUT') {
      throw err
    } else {
      log(
        'warn',
        `saveFile timeout: still ${entries.length - savedEntries.length} / ${
          entries.length
        } to download`
      )
    }
  }

  log(
    'info',
    `saveFiles created ${savedFiles} files for ${
      savedEntries ? savedEntries.length : 'n'
    } entries`
  )
  return savedEntries
}

module.exports = saveFiles

function getFileName(entry) {
  let filename
  if (entry.filename) {
    filename = entry.filename
  } else if (entry.filestream) {
    log('debug', omit(entry, 'filestream'))
    logFileStream(entry.filestream)
    throw new Error('Missing filename property')
  } else {
    // try to get the file name from the url
    const parsed = require('url').parse(entry.fileurl)
    filename = path.basename(parsed.pathname)
  }
  return sanitizeFileName(filename)
}

function sanitizeFileName(filename) {
  return filename.replace(/^\.+$/, '').replace(/[/?<>\\:*|":]/g, '')
}

function checkFileSize(fileobject) {
  if (fileobject.attributes.size === 0) {
    log('warn', `${fileobject.attributes.name} is empty`)
    log('warn', 'BAD_FILE_SIZE')
    return false
  }
  return true
}

function checkMimeWithPath(mime, filepath) {
  const extension = path.extname(filepath).substr(1)
  if (extension && mime && mimetypes.lookup(extension) !== mime) {
    log('warn', `${filepath} and ${mime} do not correspond`)
    log('warn', 'BAD_MIME_TYPE')
    return false
  }
  return true
}

function logFileStream(fileStream) {
  if (!fileStream) return

  if (fileStream && fileStream.constructor && fileStream.constructor.name) {
    log(
      'info',
      `The fileStream attribute is an instance of ${
        fileStream.constructor.name
      }`
    )
  } else {
    log('info', `The fileStream attribute is a ${typeof fileStream}`)
    // console.log(fileStream)
  }
}

function getErrorStatus(err) {
  try {
    return Number(JSON.parse(err.message).errors[0].status)
  } catch (e) {
    return null
  }
}
