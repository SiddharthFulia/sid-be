export const success = (res, data, message = 'OK', status = 200) => {
  return res.status(status).json({ status: true, message, data });
};

export const error = (res, message = 'Something went wrong', status = 500, data = null) => {
  return res.status(status).json({ status: false, message, data });
};
