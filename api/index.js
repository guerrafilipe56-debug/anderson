const { handleServerlessRequest } = require("../server");

module.exports = async (request, response) => {
  await handleServerlessRequest(request, response);
};
