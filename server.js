import express from 'express';
import http from 'http';
import cors from 'cors';
import bodyParser from 'body-parser';
import { Server } from 'socket.io';
import redis from 'redis';
import { EntityId, Repository, Schema } from 'redis-om';
import { promises as fs } from 'fs';

// TODOs:
// - handle disconnects/reconnects
// - settings when creating a lobby (time to draw, # of rounds, hints, transfer ownership?, ...)
// - avatars - drawings?
// - reset player points

// Array of words
let words = [];

// Read the file with words
fs.readFile('slovene.txt', 'utf8')
  .then((data) => {
    words = data
      .split('\n')
      .map((word) => word.trim())
      .filter((word) => word !== '');
  })
  .catch((err) => {
    console.error(err);
    return;
  });

// Function to select random words from the array
function getRandomWords(count) {
  const randomWords = [];
  const arrayCopy = [...words];

  for (let i = 0; i < count; i++) {
    const randomIndex = Math.floor(Math.random() * arrayCopy.length);
    const randomWord = arrayCopy.splice(randomIndex, 1)[0];
    randomWords.push(randomWord);
  }

  return randomWords;
}

// generate hints
function getRandomIndexesAndLetters(word) {
  const result = [];

  // Generate two distinct random indexes
  let index1, index2;
  do {
    index1 = Math.floor(Math.random() * word.length);
    index2 = Math.floor(Math.random() * word.length);
  } while (index1 === index2);

  // Create objects with index and letter properties
  result.push({ index: index1, letter: word[index1] });
  result.push({ index: index2, letter: word[index2] });

  return result;
}

const checkForCloseGuess = (guess, toGuess) => {
  // console.log(`checking proximity for ${guess} and ${toGuess}`);
  // TODO comparison logic
};

const determineNextDrawer = (lobbyInfo) => {
  // find the index of the current drawer
  const currentDrawerIndex = lobbyInfo?.players?.findIndex(
    (player) => player?.playerId === lobbyInfo?.gameState?.drawingUser
  );

  // find all candidates (connected players with lower index)
  let candidates = lobbyInfo?.players?.filter(
    (player, index) => index < currentDrawerIndex && player?.connected
  );
  if (candidates?.length) {
    return candidates?.[candidates?.length - 1];
  } else {
    return null;
  }
};

// TODO fill this up with missing properties
const lobbySchema = new Schema('lobby', {
  name: { type: 'string' },
  status: { type: 'string' },
  playersIds: { type: 'string[]', path: '$.players[*].playerId' },
  playersSocketIds: { type: 'string[]', path: '$.players[*].socketId' },
  playersScore: { type: 'number[]', path: '$.players[*].score' },
});

const app = express();
const server = http.createServer(app);
const socketIO = new Server(server, {
  cors: {
    origin: '*',
  },
});

const redisClient = redis.createClient({ url: 'redis://localhost:9911' });

const lobbyRepository = new Repository(lobbySchema, redisClient);

redisClient
  .connect()
  .then((res) => {
    // console.log('Redis connect success: ', res);
  })
  .catch((err) => {
    console.error('Redis no connect: ', err);
  });

redisClient.on('ready', () => {
  // console.log('Redis ready - Connected!');
  lobbyRepository
    .createIndex()
    .then((res) => {
      // console.log('create index res: ', res);
    })
    .catch((err) => {
      // console.log('create index error res: ', err);
    });
});

redisClient.on('error', (err) => {
  console.error('redis error: ', err);
});

app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 9030;

const prepareNextRound = (tempLobby) => {
  // calculate points for winner and the person drawing
  // TODO balance this at some point down the road

  // map over players and check if they had a correct guess and then score them on based on their placement
  let roundScoreboard = tempLobby?.players?.map((player) => ({
    playerId: player?.playerId,
    score:
      tempLobby?.gameState?.roundWinners?.findIndex(
        (pl) => pl?.userName === player?.playerId
      ) === -1
        ? 0
        : 500 -
          tempLobby?.gameState?.roundWinners?.findIndex(
            (pl) => pl?.userName === player?.playerId
          ) *
            50,
  }));

  // find the drawer and award them point based the number of correct guesses
  let drawerIndexOnTheRoundScoreboard = roundScoreboard?.findIndex(
    (el) => el?.playerId === tempLobby?.gameState?.drawingUser
  );
  roundScoreboard[drawerIndexOnTheRoundScoreboard].score =
    tempLobby?.gameState?.roundWinners?.length === 0
      ? 0
      : 200 + tempLobby?.gameState?.roundWinners?.length * 50; // 0 pts if noone guessed correcty and 200 base + 50 per correct guess if there are round winners

  // and finnally sort the roundScoreboard array
  let sortedRoundScoreboard = roundScoreboard?.sort(
    (a, b) => b?.score - a?.score
  );

  // add points to players total
  sortedRoundScoreboard
    ?.filter((pws) => pws?.score > 0)
    ?.forEach((sbtz) => {
      let tindex = tempLobby?.players?.findIndex(
        (tlp) => tlp?.playerId === sbtz?.playerId
      );
      tempLobby.players[tindex].score += sbtz?.score;
    });

  let tempUnmaskedWord = tempLobby.gameState.wordToGuess;
  // determine who is drawing next

  // find the index of the current drawer
  let currentDrawerIndex = tempLobby?.players?.findIndex(
    (player) => player?.playerId === tempLobby?.gameState?.drawingUser
  );

  let socketIdForDrawingNext = null;

  let nextDrawer = determineNextDrawer(tempLobby);
  if (
    // currentDrawerIndex + 1 >= tempLobby?.players?.length &&
    nextDrawer === null &&
    tempLobby?.gameState?.totalRounds === tempLobby?.gameState?.roundNo
  ) {
    // gameOver
    tempLobby.status = 'roundOver';
    tempLobby.gameState.drawState = [];
    tempLobby.gameState.wordToGuess = null;
    tempLobby.gameState.roundWinners = [];
    tempLobby.gameState.hints = [];
    tempLobby.gameState.canvas = [];

    lobbyRepository
      .save(tempLobby)
      .then((saveres) => {
        socketIO.to(tempLobby.name).emit('lobbyStatusChange', {
          newStatus: 'roundOver',
          info: {
            unmaskedWord: tempUnmaskedWord,
            roundScoreboard: sortedRoundScoreboard,
            players: tempLobby?.players,
          },
        });
      })
      .catch((saverr) => {
        console.log(saverr);
      });

    setTimeout(() => {
      tempLobby.status = 'gameOver';
      lobbyRepository
        .save(tempLobby)
        .then((gameoverlobby) => {
          socketIO.to(tempLobby.name).emit('lobbyStatusChange', {
            newStatus: 'gameOver',
          });
        })
        .catch((gameovererror) => {
          console.log('game over error: ', gameovererror);
        });
    }, 7500);
  } else {
    // apply changes/resets to the lobby
    tempLobby.status = 'roundOver';
    tempLobby.gameState.drawState = [];
    tempLobby.gameState.wordToGuess = null;
    tempLobby.gameState.roundWinners = [];
    tempLobby.gameState.hints = [];
    tempLobby.gameState.canvas = [];

    if (nextDrawer === null) {
      // next round
      tempLobby.gameState.roundNo = tempLobby.gameState.roundNo + 1;
      let allConnected = tempLobby?.players?.filter(
        (player) => player.connected
      );
      tempLobby.gameState.drawingUser =
        allConnected[allConnected?.length - 1]?.playerId;
      socketIdForDrawingNext = allConnected[allConnected?.length - 1]?.socketId;
    } else {
      // next player
      tempLobby.gameState.drawingUser = nextDrawer?.playerId;
      socketIdForDrawingNext = nextDrawer?.socketId;
    }

    // emit roundOver
    lobbyRepository
      .save(tempLobby)
      .then((saveres) => {
        socketIO.to(tempLobby.name).emit('lobbyStatusChange', {
          newStatus: 'roundOver',
          info: {
            drawingNext: saveres.gameState.drawingUser,
            unmaskedWord: tempUnmaskedWord,
            roundScoreboard: sortedRoundScoreboard,
            players: tempLobby?.players,
          },
        });

        setTimeout(() => {
          let wordsToPickFrom = getRandomWords(3);

          socketIO.to(tempLobby.name).emit('lobbyStatusChange', {
            newStatus: 'pickingWord',
            info: { drawingUser: saveres.gameState.drawingUser },
          });

          socketIO.to(socketIdForDrawingNext).emit('pickAWord', {
            arrayOfWordOptions: wordsToPickFrom,
          });
        }, 10000);
      })
      .catch((saverr) => {
        console.log(saverr);
      });
  }
};

// WebSocket server logic
socketIO.on('connection', (socket) => {
  console.log('WebSocket client connected: ', socket?.id);

  socket.on('join', ({ lobbyName, userName, lastKnownSocketId }) => {
    const normalConnectAttempt = () => {
      // join the socket and lobby if it exist or return an error if it doesn't

      lobbyRepository
        .search()
        .where('name')
        .equals(lobbyName)
        .returnAll()
        .then((response) => {
          if (response?.length === 0) {
            // lobby that we are trying to join doesn't exist - return an error
            // TODO ne vem tocno ki tu nrdit
            // res.status(404).json({
            //   message: `Lobby "${lobbyName}" doesn't exist.`,
            // });
          } else {
            // lobbby with this name exists

            // we join the socket
            socket.join(lobbyName);

            // and we join the lobby
            let lobbyToJoin = response?.[0];
            let oldPlayers = lobbyToJoin?.players;
            lobbyToJoin.players = [
              ...oldPlayers,
              {
                playerId: userName,
                socketId: socket?.id,
                connected: true,
                isOwner: lobbyToJoin?.players?.length === 0 ? true : false, // become lobby owner if you are joining an empty lobby
                score: 0,
              },
            ];

            lobbyRepository
              .save(lobbyToJoin)
              .then((ljRes) => {
                socketIO.to(lobbyName).emit('userStateChange', {
                  newUserState: ljRes.players,
                });

                socketIO.to(socket?.id).emit('connectAttemptResponse', {
                  response: {
                    allGood: true,
                  },
                });

                socketIO.to(lobbyName).emit('message', {
                  message: {
                    type: 'playerJoiningOrLeaving',
                    content: `Player ${userName} joined the lobby.`,
                  },
                  userName: 'server',
                  serverMessage: true,
                });

                // console.log('lobbies after join: ', lobbies);
                // console.log(
                //   'all rooms after connect: ',
                //   socketIO?.sockets?.adapter?.rooms
                // );
              })
              .catch((err) => {
                console.log('lobbyJoin error: ', err);
              });
          }
        })
        .catch((err) => {
          console.log('error pri iskanju 333: ', err);
        });
    };
    // DOING

    // use client's socketId to check if they are already in any of the lobbies

    if (lastKnownSocketId) {
      // we need to check if this person is 1) reconnecting or 2) already active in another lobby

      lobbyRepository
        .search()
        .where('playersSocketIds')
        .contains(lastKnownSocketId)
        .returnFirst()
        .then((lobbyWithLastKnown) => {
          if (lobbyWithLastKnown) {
            // this user is already connected to a lobby - check if this is the current lobby he is trying to (re)connect to or a different lobby
            if (lobbyWithLastKnown?.name == lobbyName) {
              let tempReconnectLobby = lobbyWithLastKnown;

              // reconnecting
              // we join the socket
              socket.join(lobbyName);

              // find index
              let reconnectedPlayerIndex =
                tempReconnectLobby?.players?.findIndex(
                  (player) => player?.socketId === lastKnownSocketId
                );

              // change connected to true
              tempReconnectLobby.players[
                reconnectedPlayerIndex
              ].connected = true;

              // set the new socketId
              tempReconnectLobby.players[reconnectedPlayerIndex].socketId =
                socket?.id;

              lobbyRepository
                .save(tempReconnectLobby)
                .then((rcnres) => {
                  socketIO.to(lobbyName).emit('userStateChange', {
                    newUserState: rcnres.players,
                  });

                  socketIO.to(socket?.id).emit('connectAttemptResponse', {
                    response: {
                      allGood: true,
                    },
                  });

                  socketIO.to(lobbyName).emit('message', {
                    message: {
                      type: 'playerJoiningOrLeaving',
                      content: `Player ${userName} reconnected.`,
                    },
                    userName: 'server',
                    serverMessage: true,
                  });
                })
                .catch((err) => {
                  console.log('lobbyJoin error: ', err);
                });
            } else {
              // TODO active somewhere else
              socketIO.to(socket?.id).emit('connectAttemptResponse', {
                response: {
                  alreadyActive: true,
                },
              });

              //
            }
          } else {
            // this person was active before but the lobby he was a part of doesn't exist anymore
            normalConnectAttempt();
          }
        })
        .catch((oops) => {
          console.log('oops: ', oops);
        });
    } else {
      // completely fresh connect attempt
      normalConnectAttempt();
    }
  });

  socket.on(
    'message',
    ({ userName, lobbyName, messageType, messageContent }) => {
      // the types of messages that we should handle:
      // 1. drawer - just broadcast the message to the lobby
      // 2. player who is still guessing - check if correct, close call or normal message

      lobbyRepository
        .search()
        .where('name')
        .equals(lobbyName)
        .returnFirst()
        .then((ourLobby) => {
          // console.log('our lobby on message res: ', ourLobby);

          let tempLobby = ourLobby;

          // check that the message is not coming from the person drawing
          if (tempLobby.gameState.drawingUser !== userName) {
            // if the lobby's status is 'playing' we are considering this a guess and will compare it to the 'wordToGuess'
            if (tempLobby.status === 'playing') {
              if (
                tempLobby?.gameState?.roundWinners?.filter(
                  (winner) => winner?.userName === userName
                )?.length > 0
              ) {
                // the player is one of the winners -> broadcast the message to other round winners
                tempLobby.gameState.roundWinners.forEach((winner) => {
                  socketIO.to(winner.socketId)?.emit('message', {
                    message: {
                      type: 'winnersOnly',
                      content: messageContent,
                    },
                    userName: userName,
                    serverMessage: false,
                  });
                });

                // and the person drawing
                let personDrawingSocketId = tempLobby.players.filter(
                  (player) =>
                    player.playerId === tempLobby.gameState.drawingUser
                )[0].socketId;

                socketIO.to(personDrawingSocketId)?.emit('message', {
                  message: {
                    type: 'winnersOnly',
                    content: messageContent,
                  },
                  userName: userName,
                  serverMessage: false,
                });

                return;
              } else {
                // console.log('checking for correct guess');
                let wordToGuess = ourLobby.gameState.wordToGuess;
                let guess = messageContent?.trim()?.toLowerCase();
                if (guess === wordToGuess) {
                  // correct guess
                  // console.log('correct guess!');

                  // don't broadcast the correct guess - broadcast the correct guess server alert instead

                  // add the player to the winners array
                  tempLobby.gameState.roundWinners.push({
                    userName: userName,
                    socketId: socket.id,
                  });

                  // if this was the first correct guess and there is at least 31s left in the round we set time tmieleft to 30 and emit the event
                  if (
                    tempLobby?.gameState?.roundWinners?.length === 1 &&
                    tempLobby?.gameState?.roundEndTimeStamp -
                      new Date().getTime() / 1000 >=
                      31
                  ) {
                    let newRoundEndTimeStamp =
                      Math.floor(new Date().getTime() / 1000) + 30;
                    tempLobby.gameState.roundEndTimeStamp =
                      newRoundEndTimeStamp;

                    socketIO.to(lobbyName).emit('newRoundEndTimeStamp', {
                      newRoundEndTimeStamp: newRoundEndTimeStamp,
                    });
                  }

                  lobbyRepository
                    .save(tempLobby)
                    .then((winnerSaveRes) => {
                      // check if all the players have guessed the word and finish the round
                      if (
                        winnerSaveRes?.gameState?.roundWinners?.length ===
                        winnerSaveRes?.players?.length - 1
                      ) {
                        prepareNextRound(winnerSaveRes);
                      }
                    })
                    .catch((err) => {
                      console.log('lobbyJoin error: ', err);
                    });

                  // emit the correctGuess message to the whole lobby
                  socketIO.to(lobbyName).emit('message', {
                    message: { type: 'correctGuess', content: userName },
                    serverMessage: true,
                  });

                  // emit unmaskedWord to the person correctly guessing
                  socketIO.to(socket.id).emit('unmaskedWord', {
                    unmaskedWord: wordToGuess,
                  });
                  return;
                } else if (checkForCloseGuess(guess, wordToGuess)) {
                  // TODO broadcast the 'close guess' message to the user only + broadcast as a normal message to all the users (so no return here)
                  socketIO.to(socket?.id)?.emit('message', {
                    message: { type: 'closeGuess' },
                    serverMessage: true,
                  });
                }
              }
            }
          }

          // The message did not fall into any of the special categories so it's a normal message that should be broadcasted to the lobby
          socketIO.to(lobbyName).emit('message', {
            userName: userName,
            message: { type: messageType, content: messageContent },
            serverMessage: false,
          });
        })
        .catch((err) => {
          console.log('elerr: ', err);
        });
    }
  );

  socket.on('startGame', ({ userName, lobbyName }) => {
    lobbyRepository
      .search()
      .where('name')
      .equals(lobbyName)
      .returnFirst()
      .then((ourLobby) => {
        // find index of our player in the lobby
        let tempLobby = ourLobby;
        let playerIndex = tempLobby?.players?.findIndex(
          (player) => player?.playerId === userName
        );

        // check if the player even has the permission to start the game (isOwner === true)
        if (tempLobby.players[playerIndex].isOwner) {
          // they are the owner - start

          // starting the game
          tempLobby.status = 'pickingWord';
          tempLobby.gameState = {
            totalRounds: 3, // TODO lobby owner should be able to set the # of rounds
            roundNo: 1,
            drawingUser:
              tempLobby?.players?.[tempLobby?.players?.length - 1]?.playerId,
            drawState: [],
            wordToGuess: null,
            roundWinners: [],
            roundEndTimeStamp: null,
            canvas: [],
          };

          let wordsToPickFrom = getRandomWords(3);
          let drawerSocketId =
            tempLobby?.players?.[tempLobby?.players?.length - 1]?.socketId;

          lobbyRepository
            .save(tempLobby)
            .then((saveres) => {
              // console.log('save res: ', saveres);
              socketIO.to(lobbyName).emit('lobbyStatusChange', {
                newStatus: 'pickingWord',
                info: {
                  drawingUser:
                    tempLobby?.players?.[tempLobby?.players?.length - 1]
                      ?.playerId,
                },
              });

              socketIO.to(drawerSocketId).emit('pickAWord', {
                arrayOfWordOptions: wordsToPickFrom,
              });
            })
            .catch((saverr) => {
              console.log('save err: ', saverr);
            });
        } else {
          // no permission to start the game
        }
      })
      .catch((err) => {
        console.log('elerr: ', err);
      });
  });

  socket.on('wordPick', ({ pickedWord, lobbyName, userName }) => {
    const epochNow = Math.floor(new Date().getTime() / 1000);
    // console.log('picked word was: ', pickedWord);

    // ackn the choice
    socketIO.to(socket.id).emit('startDrawing', { wordToDraw: pickedWord });

    // redis game state

    lobbyRepository
      .search()
      .where('name')
      .equals(lobbyName)
      .returnFirst()
      .then((ourLobby) => {
        // console.log('ulres: ', ourLobby);
        // find index of our player in the lobby
        let tempLobby = ourLobby;

        tempLobby.status = 'playing';
        tempLobby.gameState.wordToGuess = pickedWord;
        tempLobby.gameState.roundEndTimeStamp = epochNow + 60;
        tempLobby.gameState.hints = getRandomIndexesAndLetters(pickedWord);

        lobbyRepository
          .save(tempLobby)
          .then((saveres) => {
            // notify the players but send the masked version of the word
            let maskedWord = pickedWord?.replace(/\S/g, '_');

            socketIO.to(lobbyName).emit('lobbyStatusChange', {
              newStatus: 'playing',
              info: {
                maskedWord: maskedWord,
                drawingUser: userName,
                roundEndTimeStamp: epochNow + 60,
              },
            });
          })
          .catch((saverr) => {
            console.log('save err: ', saverr);
          });
      })
      .catch((err) => {
        console.log('elerr: ', err);
      });
  });

  // this is every single drawn pixel coming in and immidiately being sent to other players for a 'real-time' expirence
  socket.on('draw', ({ newLine, lobbyName }) => {
    // emit new paths as a 'newLine' to all players in the lobby except the person drawing
    socket.to(lobbyName).emit('newLine', {
      newLine: newLine,
    });
  });

  socket.on('fill', ({ fillInfo, lobbyName }) => {
    // emit to all the players in the lobby except the person drawing
    socket.to(lobbyName).emit('fill', {
      fillInfo: fillInfo,
    });

    // store in Redis
    lobbyRepository
      .search()
      .where('name')
      .equals(lobbyName)
      .returnFirst()
      .then((ourLobby) => {
        let tempLobby = ourLobby;
        tempLobby.gameState.canvas.push({
          type: 'fill',
          content: fillInfo,
        });

        lobbyRepository
          .save(tempLobby)
          .then((resp) => {
            // no need to do anything here
          })
          .catch((fillerr) => {
            console.log('save fill error: ', fillerr);
          });
      })
      .catch((err) => {
        console.log(err);
      });
  });

  // this is a 'full-line' coming in - it is an array of pixels coming in after the player relases the mouse button hold. It is used to update the state in redis which allows the 'undo' action and reconnects to work
  socket.on('fullLine', ({ fullLine, lobbyName }) => {
    lobbyRepository
      .search()
      .where('name')
      .equals(lobbyName)
      .returnFirst()
      .then((ourLobby) => {
        let tempLobby = ourLobby;
        tempLobby.gameState.canvas.push({
          type: 'line',
          content: fullLine,
        });

        lobbyRepository
          .save(tempLobby)
          .then((resp) => {
            // no need to do anything here
          })
          .catch((dcserr) => {
            console.log('save on disconnect error: ', dcserr);
          });
      })
      .catch((err) => {
        console.log(err);
      });
  });

  socket.on('undo', ({ lobbyName }) => {
    lobbyRepository
      .search()
      .where('name')
      .equals(lobbyName)
      .returnFirst()
      .then((ourLobby) => {
        let tempLobby = ourLobby;

        let preUndoCanvas = tempLobby.gameState.canvas;
        preUndoCanvas.pop();
        tempLobby.gameState.canvas = preUndoCanvas;

        lobbyRepository
          .save(tempLobby)
          .then((resp) => {
            // emit the full drawing to all the users to reset the canvas to full-1
            socketIO.to(lobbyName).emit('canvasAfterUndo', {
              newCanvas: resp.gameState.canvas,
              isCanvasEmpty: resp.gameState.canvas.length === 0 ? true : false,
            });
          })
          .catch((xerr) => {
            console.log(xerr);
          });
      })
      .catch((err) => {
        console.log(err);
      });
  });

  socket.on('triggerRoundEndByTimer', ({ userName, lobbyName }) => {
    lobbyRepository
      .search()
      .where('name')
      .equals(lobbyName)
      .returnFirst()
      .then((ourLobby) => {
        let tempLobby = ourLobby;

        // make sure the player that triggered this event is the person drawing
        if (tempLobby.gameState.drawingUser === userName) {
          prepareNextRound(tempLobby);
        }
      })
      .catch((err) => {
        console.log(err);
      });
  });

  socket.on('triggerHint', ({ userName, lobbyName, index }) => {
    lobbyRepository
      .search()
      .where('name')
      .equals(lobbyName)
      .returnFirst()
      .then((ourLobby) => {
        // make sure the player that triggered this event is the person drawing
        if (ourLobby.gameState.drawingUser === userName) {
          // emit hint
          socket.to(lobbyName).emit('hint', {
            hint: ourLobby?.gameState?.hints[index],
          });
        }
      })
      .catch((err) => {
        console.log(err);
      });
  });

  socket.on('disconnect', () => {
    console.log(`Disconnect msg coming from socketid ${socket?.id}`);

    lobbyRepository
      .search()
      .where('playersSocketIds')
      .contains(socket?.id)
      .returnFirst()
      .then((r) => {
        console.log('to je leaval: ', r);
        let tempLobby = r;
        let playerIndex = tempLobby?.players?.findIndex(
          (player) => player?.socketId === socket?.id
        );

        // check if disconnecting player is owner and find a new owner
        // and if there is more than 1 players find the index of the first connected non-owner player
        if (
          tempLobby?.players?.[playerIndex]?.isOwner &&
          tempLobby?.players?.length > 1
        ) {
          let newOwnerIndex = tempLobby?.players?.findIndex(
            (player) => player.connected && !player.isOwner
          );
          tempLobby.players[newOwnerIndex].isOwner = true;
        }

        // depending on the game status remove or just change the connection status of the disconnecting player
        if (r?.status === 'open' || r?.status === 'gameOver') {
          // if the status of the lobby equals 'open' or 'gameOver' we remove the player on disconnect
          tempLobby?.players?.splice?.(playerIndex, 1);
        } else {
          // if the game is active, we change their 'connected' to false
          tempLobby.players[playerIndex].connected = false;

          // we also check if the person who disconnected is the person drawing - in this case we end the round

          // TODO HAS TO BE IMPLEMENTED!
        }

        lobbyRepository
          .save(tempLobby)
          .then((dcsr) => {
            // check how many CONNECTED players remain in the lobbby - if the lobby is empty after the disconnect, delete it
            let throwawayPlayers = [...dcsr?.players];
            let stillConnected = throwawayPlayers?.filter?.(
              (player) => player?.connected
            )?.length;

            if (stillConnected === 0) {
              // delete the lobbby as there is no more connected players in it

              lobbyRepository
                .remove(r[EntityId])
                .then(() => {
                  console.log('lobby deleted');
                })
                .catch((removeerr) => {
                  console.log('error deleting lobby: ', removeerr);
                });
            } else if (stillConnected === 1) {
              // TODO
              // only one player remains - end the game because not enough active players left
              // gameover status with extra message about there not beeing enought players to keep the game going
            } else {
              // someone disconnected but the game goes on
            }

            // emit the new lobby state as a 'lobbyUpdate' to all players in the lobby
            //
            socketIO.to(r?.name).emit('userStateChange', {
              newUserState: dcsr.players,
            });
            //
          })
          .catch((dcserr) => {
            console.log('save on disconnect error: ', dcserr);
          });
      })
      .catch((err) => {
        console.log('liv eror: ', err);
      });

    // console.log('all rooms after dc: ', socketIO?.sockets?.adapter?.rooms);
  });
});

app.get('/api/getAllLobbies', function (req, res) {
  lobbyRepository
    .search()
    .return.all()
    .then((resp) => {
      // console.log('vsi lobiji res na serverju: ', resp);
      if (resp?.length > 0) {
        // obstajajo lobiji
        const lobbiesArray = [];
        resp?.forEach((lobby) => {
          lobbiesArray.push({
            name: lobby?.name,
            status: lobby?.status,
            players: lobby?.players,
          });
        });
        res.status(200).json({
          lobbies: lobbiesArray,
        });
      } else {
        res.status(404).json({
          message: 'No lobbies found.',
        });
      }
    })
    .catch((err) => {
      console.log('error pri vseh lobijih na serveju: ', err);
    });
  // res.send(lobbiesArray);
});

app.get('/api/getLobby/:id', function (req, res) {
  const lobbyName = req?.params?.id;

  lobbyRepository
    .search()
    .where('name')
    .equals(lobbyName)
    .returnAll()
    .then((response) => {
      if (response?.length === 0) {
        // lobby doesn't exist
        console.log(`lobby ${lobbyName} doesn't exist`);
        res.status(404).json({
          message: `Lobby ${lobbyName} doesn't exist`,
        });
      } else {
        console.log(`lobby ${lobbyName} exist`);
        res.status(200).json({
          lobbyInfo: response[0],
        });
      }
    })
    .catch((err) => {
      console.log('error pri iskanju111111111: ', err);
    });
});

app.post('/api/joinLobby', function (req, res) {
  const lobbyName = req?.body?.lobbyName;
  const lastKnownSocketId = req?.body?.lastKnownSocketId;

  // if request has lastKnownSocketId check if we are already in a lobby and is it this one (reconnecting user)

  if (req?.body?.lastKnownSocketId) {
    lobbyRepository
      .search()
      .where('playersSocketIds')
      .contains(lastKnownSocketId)
      .returnFirst()
      .then((lobbyWithLastKnown) => {
        if (lobbyWithLastKnown) {
          // this user is already connected to a lobby - check if it is this one
          if (lobbyName == lobbyWithLastKnown?.name) {
            // this is a reconnect
            console.log(
              `lobby ${lobbyName} exist and the user is reconnecting to it`
            );
            res.status(200).json({
              message: `You can reconnect ${lobbyName}`,
              lobbyInfo: lobbyWithLastKnown,
            });
            return;
          } else {
            // not reconnect but not allowed to join (only 1 active game at a time)
            console.log(`This user is already in another lobby`);
            res.status(200).json({
              message: `Lobby ${lobbyName} is full`,
              alreadyActiveInAnotherLobby: true, // TODO handle on the FE
            });
            return;
          }
        }
      })
      .catch((errorka) => {
        console.log(errorka);
      });
  }

  lobbyRepository
    .search()
    .where('name')
    .equals(lobbyName)
    .returnFirst()
    .then((ourLobby) => {
      if (ourLobby) {
        // lobbby exists
        if (ourLobby?.players?.length == 10) {
          // full
          console.log(`lobby ${lobbyName} is full`);
          res.status(200).json({
            message: `Lobby ${lobbyName} is full`,
            full: true,
          });
        } else {
          console.log(`lobby ${lobbyName} exist`);
          res.status(200).json({
            message: `You can join ${lobbyName}`,
            lobbyInfo: ourLobby,
          });
        }
      } else {
        // lobby doesn't exist
        console.log(`lobby ${lobbyName} doesn't exist`);
        res.status(404).json({
          message: `Lobby ${lobbyName} doesn't exist`,
        });
      }
    })
    .catch((err) => {
      console.log('error pri iskanju123123: ', err);
    });
});

app.post('/api/createLobby', function (req, res) {
  const lobbyName = req?.body?.lobbyName;

  // TODO check if the person creating the lobby is already active in another lobby and then don't create the lobby

  // logika za preverjanje ustvarjanja lobbyja - lobby s tem imenom se ne obstaja
  lobbyRepository
    .search()
    .where('name')
    .equals(lobbyName)
    .returnAll()
    .then((response) => {
      if (response?.length === 0) {
        // lobby doesn't exist yet - create it
        lobbyRepository
          .save({
            name: lobbyName,
            status: 'open',
            players: [],
          })
          .then((resp) => {
            // console.log('lobby creation response: ', resp);
            // lobby successfully created on redis
            res.status(201).json({
              lobbyName: lobbyName,
              message: `Lobby ${lobbyName} successfully created.`,
            });
          })
          .catch((err) => {
            console.log('lobby creation error: ', err);
          });
      } else {
        // lobbby with this name already exists
        console.log(`server ${lobbyName} ze obstaja`);
        res.status(400).json({
          message: `Lobby with name "${lobbyName}" alerady exists.`,
        });
      }
    })
    .catch((err) => {
      console.log('error pri iskanju 222: ', err);
    });
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
