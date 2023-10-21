import express from 'express';
import http from 'http';
import cors from 'cors';
import bodyParser from 'body-parser';
import { Server } from 'socket.io';
import redis from 'redis';
import { Repository, Schema } from 'redis-om';
import { promises as fs } from 'fs';

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

const checkForCloseGuess = (guess, toGuess) => {
  console.log(`checking proximity for ${guess} and ${toGuess}`);
  // TODO comparison logic
};

const lobbySchema = new Schema('lobby', {
  name: { type: 'string' },
  status: { type: 'string' },
  playersIds: { type: 'string[]', path: '$.players[*].playerId' },
  playersSocketIds: { type: 'string[]', path: '$.players[*].socketId' },
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
    console.log('Redis connect success: ', res);
  })
  .catch((err) => {
    console.error('Redis no connect: ', err);
  });

redisClient.on('ready', () => {
  console.log('Redis ready - Connected!');
  lobbyRepository
    .createIndex()
    .then((res) => {
      console.log('create index res: ', res);
    })
    .catch((err) => {
      console.log('create index error res: ', err);
    });
});

redisClient.on('error', (err) => {
  console.error('redis error: ', err);
});

app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 9030;

// WebSocket server logic
socketIO.on('connection', (socket) => {
  console.log('WebSocket client connected: ', socket?.id);

  socket.on('join', ({ lobbyName, userName }) => {
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
              isOwner: lobbyToJoin?.players?.length === 0 ? true : false, // become lobby owner if you are joing an empty lobby
              // ready: false, CHANGE: we don't track players status anymore
            },
          ];

          lobbyRepository
            .save(lobbyToJoin)
            .then((ljRes) => {
              console.log('lobbyJoinResponse: ', ljRes);

              // emit the 'starting' lobby state as a 'lobbyUpdate' to all players in the lobby
              // socketIO.to(lobbyName).emit('lobbyUpdate', {
              //   newLobbyState: ljRes,
              // });
              // TODO DOING - replaced with more specific 'userStateChange'
              socketIO.to(lobbyName).emit('userStateChange', {
                newUserState: ljRes.players,
              });
            })
            .catch((err) => {
              console.log('lobbyJoin error: ', err);
            });
        }
      })
      .catch((err) => {
        console.log('error pri iskanju 333: ', err);
      });

    // ce bom kje rabu socketId
    // lobbies.get(lobbyName).push({
    //   socketId: socket?.id,
    //   userName: userName,
    // });

    socketIO.to(lobbyName).emit('message', {
      message: {
        type: 'playerJoiningOrLeaving',
        content: `Player ${userName} joined the lobby.`,
      },
      userName: 'server',
      serverMessage: true,
    });

    // console.log('lobbies after join: ', lobbies);
    console.log('all rooms after connect: ', socketIO?.sockets?.adapter?.rooms);
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
          console.log('our lobby on message res: ', ourLobby);

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
                console.log('checking for correct guess');
                let wordToGuess = ourLobby.gameState.wordToGuess;
                let guess = messageContent?.trim()?.toLowerCase();
                if (guess === wordToGuess) {
                  // correct guess
                  console.log('correct guess!');

                  // don't broadcast the correct guess - broadcast the correct guess server alert instead

                  // add the player to the winners array
                  tempLobby.gameState.roundWinners.push({
                    userName: userName,
                    socketId: socket.id,
                  });

                  // TODO doing - check if all the players have guessed the word and finish the round

                  lobbyRepository
                    .save(tempLobby)
                    .then((winnerSaveRes) => {
                      console.log('winnersaveres: ', winnerSaveRes);
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
        console.log('ulres: ', ourLobby);
        // find index of our player in the lobby
        let tempLobby = ourLobby;
        let playerIndex = tempLobby?.players?.findIndex(
          (player) => player?.playerId === userName
        );

        // check if the player even has the permission to start the game (isOwner === true)
        if (tempLobby.players[playerIndex].isOwner) {
          // they are the owner - start
          console.log('the owner of the lobby started the game');

          // starting the game
          tempLobby.status = 'pickingWord';
          tempLobby.gameState = {
            roundNo: 1,
            drawingUser: userName,
            drawState: [],
            wordToGuess: null,
            scoreBoard: [],
            roundWinners: [],
            roundEndTimeStamp: null,
          };

          let wordsToPickFrom = getRandomWords(3);
          let drawerSocketId = tempLobby.players[playerIndex].socketId;

          lobbyRepository
            .save(tempLobby)
            .then((saveres) => {
              console.log('save res: ', saveres);
              socketIO.to(lobbyName).emit('lobbyStatusChange', {
                newStatus: 'pickingWord',
                info: { drawingUser: userName },
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
        console.log('ulres: ', ourLobby);
        // find index of our player in the lobby
        let tempLobby = ourLobby;

        tempLobby.status = 'playing';
        tempLobby.gameState.wordToGuess = pickedWord;
        tempLobby.gameState.roundEndTimeStamp = epochNow + 10; // TODO hardcoded for testing

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
                roundEndTimeStamp: epochNow + 10, // TODO hardcoded for testing
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

  socket.on('draw', ({ newLine, lobbyName }) => {
    // update redis?
    // TODO

    // emit new paths as a 'newLine' to all players in the lobby except the person drawing
    socket.to(lobbyName).emit('newLine', {
      newLine: newLine,
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
          // apply changes/resets to the lobby
          tempLobby.status = 'roundOver';
          tempLobby.gameState.drawState = [];
          tempLobby.gameState.wordToGuess = null;
          // TODO tempLobby.gameState.scoreBoard = ...
          tempLobby.gameState.roundWinners = [];
          tempLobby.gameState.roundStartTimeStamp = null;

          // determine who is drawing next

          // find the index of the current drawer
          let currentDrawerIndex = tempLobby?.players?.findIndex(
            (player) => player?.playerId === tempLobby?.gameState?.drawingUser
          );

          let socketIdForDrawingNext = null;

          if (currentDrawerIndex + 1 >= tempLobby?.players?.length) {
            // all the players have drawn, go back to index 0 and increase the rounud number
            tempLobby.gameState.roundNo = tempLobby.gameState.roundNo + 1;
            tempLobby.gameState.drawingUser = tempLobby?.players?.[0]?.playerId;
            socketIdForDrawingNext = tempLobby?.players?.[0]?.socketId;
          } else {
            // next player
            tempLobby.gameState.drawingUser =
              tempLobby?.players?.[currentDrawerIndex + 1]?.playerId;
            socketIdForDrawingNext =
              tempLobby?.players?.[currentDrawerIndex + 1]?.socketId;
          }

          lobbyRepository
            .save(tempLobby)
            .then((saveres) => {
              socketIO.to(lobbyName).emit('lobbyStatusChange', {
                newStatus: 'roundOver',
                info: {
                  drawingNext: saveres.gameState.drawingUser,
                  // TODO doing unmasked word here ro unmasked word event? zzz
                },
              });

              setTimeout(() => {
                let wordsToPickFrom = getRandomWords(3);

                socketIO.to(lobbyName).emit('lobbyStatusChange', {
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
      .contain(socket?.id)
      .return.first()
      .then((r) => {
        console.log('to je leaval: ', r);

        if (r?.status === 'open') {
          // if the status of the lobby equals 'open' we remove the player on disconnect
          // doing
          let tempLobby = r;
          let playerIndex = tempLobby?.players?.findIndex(
            (player) => player?.socketId === socket?.id
          );
          tempLobby?.players?.splice?.(playerIndex, 1);

          lobbyRepository
            .save(tempLobby)
            .then((dcsr) => {
              console.log('save on disconnect response: ', dcsr);

              // emit the new lobby state as a 'lobbyUpdate' to all players in the lobby
              // TODO DOING - replaced with more specific 'userStateChange'
              socketIO.to(r?.name).emit('userStateChange', {
                newUserState: dcsr.players,
              });
            })
            .catch((dcserr) => {
              console.log('save on disconnect error: ', dcserr);
            });
        }

        // if the game is active, we don't (immediately) remove them?
      })
      .catch((err) => {
        console.log('liv eror: ', err);
      });
    // using socketId, find the lobby user has left

    console.log('all rooms after dc: ', socketIO?.sockets?.adapter?.rooms);
  });

  socket.on('disconnect_details', ({ userName, lobbyName }) => {
    console.log(`username: ${userName} and lobbyName: ${lobbyName}`);
  });
});

app.get('/api/getAllLobbies', function (req, res) {
  lobbyRepository
    .search()
    .return.all()
    .then((resp) => {
      console.log('vsi lobiji res na serverju: ', resp);
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

  // logika za preverjanje ustvarjanja lobbyja - lobby s tem imenom se ne obstaja
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
        // lobbby exists and we can join

        //  TODO  full lobby, password, active game,...
        console.log(`lobby ${lobbyName} exist`);
        res.status(200).json({
          message: `You can join ${lobbyName}`,
          lobbyInfo: response[0],
        });
      }
    })
    .catch((err) => {
      console.log('error pri iskanju123123: ', err);
    });
});

app.post('/api/createLobby', function (req, res) {
  const lobbyName = req?.body?.lobbyName;

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
            console.log('lobby creation response: ', resp);
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
